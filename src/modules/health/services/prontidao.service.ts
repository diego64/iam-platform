/**
 * Responsabilidade: decidir se a instância consegue atender, combinando os verificadores.
 * Consumido por: o controller de health.
 * Regras:
 *  - Recebe os verificadores por injeção — não conhece `pg` nem `mongodb`.
 *  - Checagens em paralelo: em sequência, o tempo total seria a soma dos tetos.
 *  - O cache guarda sucesso, nunca falha (ver `consultarProntidao`).
 */
import type { Logger } from '../../../shared/logger/index.js';
import type { EstadoDeDependencia, Verificador } from './verificadores.js';

export interface ResultadoDeProntidao {
  readonly pronto: boolean;
  readonly encerrando: boolean;
  readonly dependencias: readonly EstadoDeDependencia[];
}

/**
 * Porta de coleta de métricas, satisfeita estruturalmente pelos instrumentos da
 * telemetria. Declarada aqui, e não importada de `telemetry/`, para o serviço continuar
 * sem conhecer OpenTelemetry — o dia em que a telemetria mudar de fornecedor, este
 * arquivo não muda.
 */
export interface ColetorDeProntidao {
  registrarTransicaoDeProntidao(dependencia: string, para: string): void;
  registrarChecagemDeProntidao(dependencia: string, duracaoSegundos: number): void;
}

export interface OpcoesDeProntidao {
  readonly verificadores: readonly Verificador[];
  readonly cacheMs: number;
  readonly logger: Logger;
  /** Ausente com a telemetria desligada — as transições seguem sendo logadas. */
  readonly coletor?: ColetorDeProntidao;
}

export interface ServicoDeProntidao {
  consultar(): Promise<ResultadoDeProntidao>;
  /** Marcado no início do encerramento, antes de o servidor parar de aceitar conexões. */
  marcarEncerrando(): void;
}

export function criarServicoDeProntidao(opcoes: OpcoesDeProntidao): ServicoDeProntidao {
  const { verificadores, cacheMs, logger, coletor } = opcoes;

  let cache: { resultado: ResultadoDeProntidao; validoAte: number } | undefined;
  // Verificação em voo. Sem isto, N consultas concorrentes chegam antes de qualquer uma
  // popular o cache e disparam N verificações — o cache só protegeria chamadas
  // sequenciais, e uma rajada de sondas bateria no banco do mesmo jeito.
  let emVoo: Promise<ResultadoDeProntidao> | undefined;
  let encerrando = false;
  // Guarda o estado anterior por dependência, para logar apenas transições.
  const ultimoEstado = new Map<string, 'up' | 'down'>();

  /**
   * Emite log só quando o estado MUDA.
   *
   * A sonda bate a cada poucos segundos; logar toda checagem encheria o log de ruído e
   * enterraria a linha que importa — justamente a da transição.
   */
  function registrarTransicoes(dependencias: readonly EstadoDeDependencia[]): void {
    for (const dependencia of dependencias) {
      // A duração entra no histograma em toda checagem, transicionando ou não: é ela que
      // mostra a dependência degradando antes de a degradação virar queda.
      coletor?.registrarChecagemDeProntidao(dependencia.nome, dependencia.duracao_ms / 1_000);

      const anterior = ultimoEstado.get(dependencia.nome);
      if (anterior === dependencia.estado) continue;

      ultimoEstado.set(dependencia.nome, dependencia.estado);
      if (anterior === undefined) continue; // primeira checagem não é transição

      coletor?.registrarTransicaoDeProntidao(dependencia.nome, dependencia.estado);

      logger.warn(
        {
          dependencia: dependencia.nome,
          de: anterior,
          para: dependencia.estado,
          duracao_ms: dependencia.duracao_ms,
          motivo: dependencia.motivo,
        },
        'health.transicao',
      );
    }
  }

  return {
    marcarEncerrando(): void {
      encerrando = true;
      // Invalida o cache: uma resposta positiva guardada antes do sinal continuaria
      // sendo servida, e o balanceador mandaria tráfego para uma instância que já
      // está drenando.
      cache = undefined;
    },

    async consultar(): Promise<ResultadoDeProntidao> {
      if (encerrando) {
        return { pronto: false, encerrando: true, dependencias: [] };
      }

      const agora = Date.now();
      if (cache !== undefined && agora < cache.validoAte) {
        return cache.resultado;
      }

      // Já existe verificação em andamento: aguarda a mesma, em vez de abrir outra.
      if (emVoo !== undefined) {
        return emVoo;
      }

      emVoo = (async (): Promise<ResultadoDeProntidao> => {
        // Paralelo, não sequencial: em série o tempo total seria a soma dos tetos, e
        // com duas dependências lentas a resposta estouraria o timeout da própria sonda.
        const dependencias = await Promise.all(verificadores.map((verificar) => verificar()));
        registrarTransicoes(dependencias);

        const pronto = dependencias.every((d) => d.estado === 'up');
        const resultado: ResultadoDeProntidao = { pronto, encerrando: false, dependencias };

        // Assimetria deliberada: só o sucesso é cacheado. Guardar o estado degradado
        // atrasaria a recuperação — o serviço voltaria a funcionar e continuaria sendo
        // reportado como fora até a janela expirar.
        cache = pronto && cacheMs > 0 ? { resultado, validoAte: Date.now() + cacheMs } : undefined;

        return resultado;
      })();

      try {
        return await emVoo;
      } finally {
        emVoo = undefined;
      }
    },
  };
}
