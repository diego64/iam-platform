/**
 * Responsabilidade: montar as respostas de liveness e readiness.
 * Regras:
 *  - Liveness NÃO consulta banco. Banco fora não se resolve reiniciando o processo, só
 *    amplifica: um liveness que checa dependência vira restart loop e derruba também as
 *    réplicas que ainda serviam.
 *  - Readiness consulta, porque a pergunta é outra: "consigo atender agora?".
 */
import type { ServicoDeProntidao } from '../services/prontidao.service.js';
import type { RespostaLive, RespostaPronta } from '../schemas/health.schema.js';

export function responderLive(): RespostaLive {
  return {
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
  };
}

export interface ResultadoDeReadiness {
  readonly status: 200 | 503;
  readonly corpo: RespostaPronta | ProblemaDeProntidao;
}

/** Corpo de erro em RFC 7807, com o detalhe por dependência que o plantão precisa. */
export interface ProblemaDeProntidao {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly dependencias?: readonly unknown[];
}

const TIPO_BASE = 'https://iam.example.com/problems';

export async function responderReady(servico: ServicoDeProntidao): Promise<ResultadoDeReadiness> {
  const resultado = await servico.consultar();

  if (resultado.encerrando) {
    return {
      status: 503,
      corpo: {
        type: `${TIPO_BASE}/shutting-down`,
        title: 'Encerrando',
        status: 503,
        detail: 'Instância em encerramento; não aceita novo tráfego',
      },
    };
  }

  if (!resultado.pronto) {
    const fora = resultado.dependencias.filter((d) => d.estado === 'down').map((d) => d.nome);

    return {
      status: 503,
      corpo: {
        type: `${TIPO_BASE}/service-unavailable`,
        title: 'Serviço indisponível',
        status: 503,
        // Nomes lógicos, nunca host ou string de conexão. Quem está de plantão precisa
        // saber QUAL caiu; quem está sondando não pode aprender nada sobre a topologia.
        detail: `Dependências indisponíveis: ${fora.join(', ')}`,
        dependencias: resultado.dependencias,
      },
    };
  }

  return {
    status: 200,
    corpo: { status: 'ready', dependencias: [...resultado.dependencias] },
  };
}
