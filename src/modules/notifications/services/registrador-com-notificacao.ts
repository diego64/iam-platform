/**
 * Responsabilidade: transformar em aviso ao dono da conta os fatos que ele precisa saber.
 * Consumido por: a composição, que empilha este sobre o decorador de detecção.
 * Regras:
 *  - Mesma escolha da SPEC 014, pelo mesmo motivo: decorar a porta faz o módulo que alguém
 *    escrever daqui a três meses entrar de graça, em vez de precisar lembrar de avisar.
 *  - **O fato é aguardado; o aviso não.** Somar uma consulta ao PostgreSQL e uma ida ao
 *    provedor de e-mail por evento colocaria a entrega no caminho crítico do login.
 *  - **Quem recebe é o afetado, não quem agiu.** Bloqueio de conta e reset de MFA são ações
 *    de administrador: o ator é quem clicou, e o alvo é quem precisa ser avisado.
 *  - Só desfecho `success`: aviso de "alguém tentou e não conseguiu" é assunto do detector,
 *    que tem limiar e silêncio. Aqui, um por tentativa seria arma contra a vítima.
 *  - Não lança nunca — nem quando o serviço de notificação explode.
 */
import { enriquecerComContexto } from '../../audit/services/contexto.js';
import type { RegistradorDeAuditoria } from '../../audit/interfaces/audit-recorder.js';
import type { EventoDeAuditoria } from '../../audit/types/audit-event.js';
import type { TipoDeEvento } from '../../audit/constants/event-types.js';
import type { TipoDeNotificacao } from '../constants/tipos.js';
import type { RepositorioDeDispositivos } from '../repositories/known-device.repository.js';
import type { ServicoDeNotificacao } from './notification.service.js';
import {
  contaBloqueada,
  loginNovo,
  mfaAlterado,
  recuperacaoUsada,
  senhaAlterada,
} from './templates.js';
import {
  medidorDeNotificacoesNulo,
  type MedidorDeNotificacoes,
} from '../metrics/notifications.metrics.js';

/**
 * De que fato nasce que aviso. Fora desta tabela, nada notifica — e é a tabela inteira que
 * um revisor precisa ler para saber o que a plataforma manda.
 */
const AVISO_POR_EVENTO: Partial<Record<TipoDeEvento, TipoDeNotificacao>> = {
  'iam.auth.login': 'login_novo',
  // Quem tem segundo fator não passa por `iam.auth.login`: o login para no desafio e quem
  // registra a entrada é o evento de MFA. Sem estas duas linhas, justamente a conta mais
  // protegida da plataforma era a única que nunca recebia aviso de acesso.
  'iam.mfa.verified': 'login_novo',
  'iam.mfa.recovery_used': 'recuperacao_usada',
  'iam.password.changed': 'senha_alterada',
  'iam.password.reset_completed': 'senha_alterada',
  'iam.mfa.enrolled': 'mfa_alterado',
  'iam.mfa.disabled': 'mfa_alterado',
  'iam.mfa.reset': 'mfa_alterado',
  'iam.user.blocked': 'conta_bloqueada',
};

export interface DependenciasDaNotificacao {
  readonly notificacoes: ServicoDeNotificacao;
  readonly dispositivos: RepositorioDeDispositivos;
  readonly medidor?: MedidorDeNotificacoes;
  readonly aoFalhar?: (erro: unknown) => void;
  readonly agora?: () => Date;
}

/** Quem é afetado pelo fato: o alvo quando existe um, senão quem agiu. */
function afetado(evento: EventoDeAuditoria): string | null {
  if (evento.target?.type === 'user') return evento.target.id;
  return evento.actor.id;
}

export function criarNotificador(deps: DependenciasDaNotificacao): {
  observar(evento: EventoDeAuditoria): Promise<void>;
} {
  const agora = deps.agora ?? ((): Date => new Date());
  const medidor = deps.medidor ?? medidorDeNotificacoesNulo();

  return {
    async observar(evento: EventoDeAuditoria): Promise<void> {
      try {
        const tipo = AVISO_POR_EVENTO[evento.type];
        if (tipo === undefined || evento.outcome !== 'success') return;

        const userId = afetado(evento);
        if (userId === null) return;

        const origem = {
          ip: evento.actor.ip ?? null,
          userAgent: evento.actor.userAgent ?? null,
          quando: agora(),
        };

        if (tipo === 'login_novo') {
          const novo = await deps.dispositivos.ehNovo({
            userId,
            ip: origem.ip,
            userAgent: origem.userAgent,
          });
          // Dispositivo conhecido é o caso comum. Avisar em todo login ensinaria a apagar
          // sem ler, e o dia do acesso suspeito pareceria igual aos outros trezentos.
          //
          // Contado, e não apenas ignorado: este é o silêncio mais frequente do sistema, e
          // sem contador "não recebi o aviso de login" não tem como ser distinguido de um
          // canal quebrado.
          if (!novo) {
            medidor.contarSupressao(tipo, 'dispositivo_conhecido');
            return;
          }

          await deps.notificacoes.notificarUsuario(userId, tipo, loginNovo(origem));
          return;
        }

        const corpo =
          tipo === 'senha_alterada'
            ? senhaAlterada(agora())
            : tipo === 'mfa_alterado'
              ? mfaAlterado(agora())
              : // Código de recuperação não passa pela checagem de dispositivo: o que chama
                // atenção é o contorno do segundo fator, não a origem de onde ele veio.
                tipo === 'recuperacao_usada'
                ? recuperacaoUsada(origem)
                : contaBloqueada(agora());

        await deps.notificacoes.notificarUsuario(userId, tipo, corpo);
      } catch (erro) {
        // O serviço já engole e conta o próprio erro; isto é a rede de segurança do que
        // sobrar — e o que sobrar não pode virar rejeição solta no processo.
        deps.aoFalhar?.(erro);
      }
    },
  };
}

export function criarRegistradorComNotificacao(
  base: RegistradorDeAuditoria,
  notificador: { observar(evento: EventoDeAuditoria): Promise<void> },
): RegistradorDeAuditoria {
  return {
    async registrar(evento: EventoDeAuditoria): Promise<void> {
      const enriquecido = enriquecerComContexto(evento);

      await base.registrar(enriquecido);

      void notificador.observar(enriquecido).catch(() => {
        /* o notificador já engole o próprio erro; aqui é só a rede de segurança */
      });
    },
  };
}
