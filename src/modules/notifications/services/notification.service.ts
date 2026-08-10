/**
 * Responsabilidade: decidir se a mensagem sai, para quem, e contar o que aconteceu.
 * Consumido por: o decorador de notificação, o canal de reset, o canal de alerta e a rota
 * de teste.
 * Regras:
 *  - **Nunca lança.** Todos os chamadores rodam fora do caminho da requisição; uma exceção
 *    aqui viraria rejeição solta, que no Node derruba o processo.
 *  - **Teto por destinatário.** É o que impede "esqueci minha senha" de virar um botão de
 *    inundar a caixa de entrada de qualquer usuário conhecido — o limite por IP da SPEC 016
 *    não alcança o atacante distribuído, porque a vítima é sempre a mesma.
 *  - **Contador indisponível deixa passar.** É o fail open já embutido no contrato dele, e
 *    para aviso de segurança a escolha é a mesma do detector: ruído é recuperável, aviso
 *    perdido não.
 *  - **O endereço não vai para o log.** Nem no sucesso, nem no erro: o que identifica a
 *    linha é o digest. Log é retido e indexado por muito mais tempo que o incidente.
 */
import type { Logger } from '../../../shared/logger/index.js';
import type { ContadorDeRateLimit } from '../../../shared/rate-limit/types.js';
import type { MotivoDeSupressao, TipoDeNotificacao } from '../constants/tipos.js';
import type { ResolvedorDeDestinatario } from '../interfaces/destinatario.port.js';
import type { ResultadoDeEntrega, TransportadorDeEmail } from '../interfaces/transporte.port.js';
import type { CorpoDeMensagem } from '../types/mensagem.js';
import {
  medidorDeNotificacoesNulo,
  type MedidorDeNotificacoes,
} from '../metrics/notifications.metrics.js';
import { criarDigestDeEndereco } from './transporte-de-log.js';

const UMA_HORA_MS = 60 * 60 * 1000;

/**
 * Baldes de cota independentes.
 *
 * Um teto único por endereço deixaria o aviso ao operador à mercê do volume de mensagens a
 * usuários — e, pior, de si mesmo: cinco alertas numa hora (plausível durante um ataque de
 * verdade) calariam os seguintes, e um administrador rodando a mensagem de teste silenciaria
 * a operação pelo resto da hora. O canal que denuncia o incidente não pode se apagar no meio
 * dele.
 */
const CATEGORIA_POR_TIPO: Readonly<Record<TipoDeNotificacao, 'usuario' | 'operacao'>> = {
  login_novo: 'usuario',
  recuperacao_usada: 'usuario',
  senha_alterada: 'usuario',
  mfa_alterado: 'usuario',
  conta_bloqueada: 'usuario',
  reset_de_senha: 'usuario',
  alerta_de_seguranca: 'operacao',
  teste: 'operacao',
};

export interface DependenciasDoServicoDeNotificacao {
  readonly transporte: TransportadorDeEmail;
  readonly destinatarios: ResolvedorDeDestinatario;
  /** Mesmo contador das janelas de limite; aqui guarda o teto por destinatário. */
  readonly teto: ContadorDeRateLimit;
  readonly maxPorHora: number;
  /**
   * Deriva o digest do destinatário. Sem pepper, o digest de um e-mail é revertido por
   * dicionário e o log volta a carregar o endereço — só que disfarçado.
   */
  readonly pepper: string;
  readonly logger: Logger;
  readonly medidor?: MedidorDeNotificacoes;
  readonly agora?: () => number;
}

export interface PedidoDeEnvio {
  readonly tipo: TipoDeNotificacao;
  readonly para: readonly string[];
  readonly corpo: CorpoDeMensagem;
}

/**
 * O desfecho de um pedido de notificação.
 *
 * Supressão é um terceiro estado, não um sabor de falha: "o teto da hora estourou" e "o
 * provedor caiu" pedem ações opostas de quem investiga, e achatar os dois em `erro` faz o
 * diagnóstico apontar para a variável de ambiente errada.
 */
export type ResultadoDeNotificacao =
  ResultadoDeEntrega | { readonly ok: false; readonly suprimida: MotivoDeSupressao };

export interface ServicoDeNotificacao {
  /** Entrega a endereços já conhecidos — operação e mensagem de teste. */
  enviar(pedido: PedidoDeEnvio): Promise<ResultadoDeNotificacao>;
  /** Entrega ao dono da conta, resolvendo o endereço pelo id do ator. */
  notificarUsuario(
    userId: string,
    tipo: TipoDeNotificacao,
    corpo: CorpoDeMensagem,
  ): Promise<ResultadoDeNotificacao>;
}

export function criarServicoDeNotificacao(
  deps: DependenciasDoServicoDeNotificacao,
): ServicoDeNotificacao {
  const medidor = deps.medidor ?? medidorDeNotificacoesNulo();
  const agora = deps.agora ?? Date.now;
  const digestDeEndereco = criarDigestDeEndereco(deps.pepper);

  function suprimir(tipo: TipoDeNotificacao, motivo: MotivoDeSupressao): ResultadoDeNotificacao {
    medidor.contarSupressao(tipo, motivo);
    return { ok: false, suprimida: motivo };
  }

  /** `true` quando o endereço ainda tem cota na categoria, na hora corrente. */
  async function temCota(tipo: TipoDeNotificacao, endereco: string): Promise<boolean> {
    const chave = `notif:${CATEGORIA_POR_TIPO[tipo]}:${digestDeEndereco(endereco)}`;
    const estado = await deps.teto.incrementar(chave, UMA_HORA_MS);
    // `null` é "não sei", não "estourou". Negar aqui transformaria queda do contador em
    // silêncio total do canal de segurança.
    return estado === null || estado.contagem <= deps.maxPorHora;
  }

  async function enviar(pedido: PedidoDeEnvio): Promise<ResultadoDeNotificacao> {
    try {
      if (pedido.para.length === 0) return suprimir(pedido.tipo, 'sem_destinatario');

      const comCota: string[] = [];
      for (const endereco of pedido.para) {
        if (await temCota(pedido.tipo, endereco)) comCota.push(endereco);
      }
      if (comCota.length === 0) return suprimir(pedido.tipo, 'teto');

      const inicio = agora();
      const resultado = await deps.transporte.enviar({
        para: comCota,
        assunto: pedido.corpo.assunto,
        texto: pedido.corpo.texto,
        html: pedido.corpo.html,
      });
      medidor.observarEntrega((agora() - inicio) / 1000);

      if (resultado.ok) {
        medidor.contarEnvio(pedido.tipo, 'ok');
        deps.logger.info(
          {
            evento: 'notification.enviada',
            tipo: pedido.tipo,
            destinatarios: comCota.map(digestDeEndereco),
          },
          'notificação entregue ao transporte',
        );
        return resultado;
      }

      medidor.contarEnvio(pedido.tipo, 'erro');
      medidor.contarFalha();
      deps.logger.error(
        {
          evento: 'notification.falhou',
          tipo: pedido.tipo,
          causa: resultado.causa,
          destinatarios: comCota.map(digestDeEndereco),
        },
        'falha ao entregar notificação',
      );
      return resultado;
    } catch (erro) {
      // Rede de segurança: nada aqui deveria lançar, e se lançar não pode subir.
      medidor.contarFalha();
      deps.logger.error(
        { err: erro, evento: 'notification.falhou', tipo: pedido.tipo },
        'erro inesperado ao notificar',
      );
      return { ok: false, causa: 'indisponivel' };
    }
  }

  return {
    enviar,

    async notificarUsuario(userId, tipo, corpo): Promise<ResultadoDeNotificacao> {
      const email = await deps.destinatarios.emailDe(userId);
      // Sem endereço não há aviso, e não há caminho de volta a partir da pista da trilha —
      // é a anonimização da SPEC 013 funcionando, não uma lacuna.
      if (email === null) return suprimir(tipo, 'sem_destinatario');

      return enviar({ tipo, para: [email], corpo });
    },
  };
}
