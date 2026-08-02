/**
 * Responsabilidade: disparar a rotação por idade da chave, sem intervenção humana.
 * Consumido por: o boot do servidor.
 * Regras:
 *  - Um ciclo nunca promove uma chave que não cumpriu a janela de pré-publicação. Quando a
 *    ativa vence e não há candidata madura, o ciclo apenas prepara e o **seguinte** promove.
 *    É por isso que a rotação real pode sair até um intervalo depois do vencimento.
 *  - Com N réplicas rodando o mesmo timer, a exclusão é do advisory lock no repositório: as
 *    perdedoras recebem `rotacao-em-andamento` e seguem em frente.
 *  - Nenhuma falha de ciclo derruba o timer. Rotação é manutenção; parar de tentar por causa
 *    de um erro transitório é pior do que tentar de novo no próximo intervalo.
 *  - O timer é `unref`: um processo que só tem este timer pendente ainda encerra sozinho.
 */
import type { Logger } from '../../../shared/logger/index.js';
import { ErroDeRotacao } from '../errors/rotation.errors.js';
import type { KeyRotationService } from './key-rotation.service.js';

export interface ConfiguracaoDoAgendador {
  readonly rotacao: KeyRotationService;
  readonly logger: Logger;
  /** Desligado, nenhum ciclo age — prepare/rotate continuam disponíveis pela API. */
  readonly habilitado: boolean;
  readonly intervaloMs: number;
  /** Idade da ativa a partir da qual a rotação é disparada. */
  readonly idadeMaximaMs: number;
  /** Relógio injetável para teste; default `Date.now`. */
  readonly agora?: () => number;
}

export interface AgendadorDeRotacao {
  iniciar(): void;
  parar(): void;
  /** Um ciclo. Exposto para teste determinístico, sem depender do timer. */
  executarCiclo(): Promise<void>;
}

export function criarAgendadorDeRotacao(config: ConfiguracaoDoAgendador): AgendadorDeRotacao {
  const agora = config.agora ?? Date.now;
  let timer: NodeJS.Timeout | undefined;

  async function executarCiclo(): Promise<void> {
    if (!config.habilitado) {
      return;
    }

    await config.rotacao.purgar();

    const idadeEmSegundos = await config.rotacao.idadeDaAtivaEmSegundos();
    if (idadeEmSegundos === null) {
      // Sem chave ativa não há o que rotacionar; criar a primeira é do bootstrap.
      return;
    }
    if (idadeEmSegundos * 1000 < config.idadeMaximaMs) {
      return;
    }

    // A ativa venceu. Garante candidata e só promove se ela já for conhecida lá fora.
    const proxima = await config.rotacao.prepararProxima();
    if (proxima.rotacionavelEm.getTime() > agora()) {
      config.logger.warn(
        { kid_novo: proxima.kid, rotacionavel_em: proxima.rotacionavelEm.toISOString() },
        'jwks.scheduler: chave ativa vencida, aguardando a pré-publicação amadurecer',
      );
      return;
    }

    await config.rotacao.rotacionar({ motivo: 'scheduled' });
  }

  return {
    executarCiclo,

    iniciar(): void {
      if (!config.habilitado || timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void executarCiclo().catch((erro: unknown) => {
          // Outra réplica rotacionando é o caminho normal em multi-instância, não incidente.
          if (erro instanceof ErroDeRotacao && erro.codigo === 'rotacao-em-andamento') {
            config.logger.info('jwks.scheduler: outra instância está rotacionando');
            return;
          }
          config.logger.error({ err: erro }, 'jwks.scheduler: ciclo falhou');
        });
      }, config.intervaloMs);
      timer.unref();
    },

    parar(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
