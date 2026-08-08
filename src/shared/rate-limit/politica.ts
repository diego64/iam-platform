/**
 * Responsabilidade: decidir se uma requisição passa, a partir do contador, e debitar cota.
 * Consumido por: o hook por identidade e o adaptador do `@fastify/rate-limit`.
 * Regras:
 *  - **Fail open**: contador indisponível deixa passar, conta o erro e registra `warn`. Rate
 *    limit é proteção de disponibilidade; negar sem saber a contagem transformaria queda do
 *    banco em queda do login, enquanto senha, denylist, detecção de reuso e MFA continuam
 *    de pé. É a inversão consciente do padrão fail-closed da plataforma.
 *  - Nada aqui lança. Um erro escapando daqui viraria 500 numa rota que deveria ter apenas
 *    deixado a requisição seguir.
 *  - `Retry-After` é o restante da janela arredondado **para cima**: arredondar para baixo
 *    convida o cliente educado a tentar um instante antes da hora e levar outro 429.
 *  - O identificador nunca entra em log nem em métrica — só a rota e a dimensão.
 */
import { derivarChave } from './chave.js';
import {
  registradorNulo,
  type RegistradorDeAuditoria,
} from '../../modules/audit/interfaces/audit-recorder.js';
import { medidorDeRateLimitNulo, type MedidorDeRateLimit } from './rate-limit.metrics.js';
import type { ContadorDeRateLimit, DimensaoDeLimite } from './types.js';

export interface Veredito {
  readonly permitido: boolean;
  readonly limite: number;
  readonly restante: number;
  /** Segundos até a janela virar. `0` quando a requisição passou. */
  readonly retryAfterSegundos: number;
}

export interface ConsultaDeLimite {
  readonly dimensao: DimensaoDeLimite;
  /** E-mail, IP ou `client_id`. É hasheado antes de virar chave. */
  readonly valor: string;
  readonly teto: number;
  readonly janelaMs: number;
  /** Só para métrica e log — nunca vai para a chave. */
  readonly rota: string;
}

export interface DependenciasDaPolitica {
  readonly contador: ContadorDeRateLimit;
  readonly pepper: string;
  readonly medidor?: MedidorDeRateLimit;
  readonly aoFalhar?: (contexto: { rota: string; dimensao: DimensaoDeLimite }) => void;
  /** Trilha de auditoria. Ausente, a política roda sem registrar — o padrão nos testes. */
  readonly auditoria?: RegistradorDeAuditoria;
  /** Relógio injetável para teste; default `Date.now`. */
  readonly agora?: () => number;
}

export interface PoliticaDeRateLimit {
  /** Lê a contagem sem debitar — o "verificar antes" das dimensões conta e cliente. */
  verificar(consulta: ConsultaDeLimite): Promise<Veredito>;
  /** Soma 1 à cota. Usado depois da tentativa, quando ela falhou. */
  debitar(consulta: ConsultaDeLimite): Promise<void>;
}

/** Sempre permite. É o que o fail open devolve, e o que uma requisição sem cota gasta vê. */
function liberado(teto: number): Veredito {
  return { permitido: true, limite: teto, restante: teto, retryAfterSegundos: 0 };
}

export function criarPoliticaDeRateLimit(deps: DependenciasDaPolitica): PoliticaDeRateLimit {
  const medidor = deps.medidor ?? medidorDeRateLimitNulo();
  const auditoria = deps.auditoria ?? registradorNulo();
  const agora = deps.agora ?? Date.now;

  /**
   * O ator do evento é o que se sabe sem revelar mais do que a resposta já revela.
   *
   * Na dimensão conta, o identificador é o e-mail: ele vai como `subjectEmail`, e quem
   * deriva a pista com pepper é o serviço de auditoria — a trilha não guarda e-mail. Na
   * dimensão cliente, o `client_id` é identificador de aplicação, não de pessoa, e vai
   * direto. Na dimensão IP não há sujeito: o 429 acontece antes de qualquer identificação.
   */
  async function registrarExcesso(consulta: ConsultaDeLimite): Promise<void> {
    await auditoria.registrar({
      type: 'iam.rate_limit.exceeded',
      actor:
        consulta.dimensao === 'cliente'
          ? { id: consulta.valor, type: 'client' }
          : { id: null, type: consulta.dimensao === 'conta' ? 'user' : 'system' },
      outcome: 'failure',
      ...(consulta.dimensao === 'conta' ? { subjectEmail: consulta.valor } : {}),
      metadata: { dimensao: consulta.dimensao, rota: consulta.rota },
    });
  }

  function chaveDe(consulta: ConsultaDeLimite): string {
    return derivarChave(consulta.dimensao, consulta.valor, deps.pepper);
  }

  function contarFalha(consulta: ConsultaDeLimite): void {
    medidor.contarErroDoContador();
    deps.aoFalhar?.({ rota: consulta.rota, dimensao: consulta.dimensao });
  }

  /** Segundos até a virada, no mínimo 1: dizer "tente em 0" é não dizer nada. */
  function segundosAte(expiraEm: Date): number {
    return Math.max(1, Math.ceil((expiraEm.getTime() - agora()) / 1000));
  }

  return {
    async verificar(consulta: ConsultaDeLimite): Promise<Veredito> {
      const inicio = agora();
      let estado;
      try {
        estado = await deps.contador.ler(chaveDe(consulta));
      } catch (erro) {
        // O contrato do contador diz que ele não lança; se lançar assim mesmo, o efeito
        // precisa ser o mesmo — a rota não pode virar 500 por causa do rate limit.
        void erro;
        estado = null;
      }
      medidor.observarDuracao((agora() - inicio) / 1000);

      if (estado === null) {
        contarFalha(consulta);
        return liberado(consulta.teto);
      }

      if (estado.contagem >= consulta.teto) {
        medidor.contarBloqueio(consulta.rota, consulta.dimensao);
        await registrarExcesso(consulta);
        return {
          permitido: false,
          limite: consulta.teto,
          restante: 0,
          retryAfterSegundos: segundosAte(estado.expiraEm),
        };
      }

      return {
        permitido: true,
        limite: consulta.teto,
        restante: consulta.teto - estado.contagem,
        retryAfterSegundos: 0,
      };
    },

    async debitar(consulta: ConsultaDeLimite): Promise<void> {
      const inicio = agora();
      let estado;
      try {
        estado = await deps.contador.incrementar(chaveDe(consulta), consulta.janelaMs);
      } catch (erro) {
        void erro;
        estado = null;
      }
      medidor.observarDuracao((agora() - inicio) / 1000);

      if (estado === null) {
        contarFalha(consulta);
      }
    },
  };
}
