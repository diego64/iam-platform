/**
 * Responsabilidade: representação base de erro em (application/problem+json).
 * Consumido por: o handler global de erros do app.
 * Regras: `detail` nunca carrega stack, SQL, nome de host interno ou valor de secret.
 *
 * Escopo: só o contrato e o handler genérico. A hierarquia de AppError por
 *  domínio e a tradução de erros de driver para AppError ficam na T02.
 */

export const TIPO_BASE = 'https://iam.example.com/problems';

export interface ProblemJson {
  /** URI que identifica o tipo do problema. */
  readonly type: string;
  /** Resumo curto e estável — não varia por ocorrência. */
  readonly title: string;
  readonly status: number;
  /** Explicação específica da ocorrência. Opcional e sempre sanitizada. */
  readonly detail?: string;
}

export function montarProblema(
  slug: string,
  title: string,
  status: number,
  detail?: string,
): ProblemJson {
  return detail === undefined
    ? { type: `${TIPO_BASE}/${slug}`, title, status }
    : { type: `${TIPO_BASE}/${slug}`, title, status, detail };
}
