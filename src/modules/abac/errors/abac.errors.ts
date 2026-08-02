/**
 * Erro de domínio do módulo de ABAC. Serviço e repositório nunca conhecem HTTP: eles
 * lançam `ErroDeAbac` e o controller consulta a tradução abaixo para montar o problem+json.
 *
 * A tradução mora aqui, e não num `switch` no controller, porque é a definição do contrato
 * de erro do módulo — o teste a confere sem precisar levantar rota nem Fastify.
 *
 * `politica-imutavel` é 409, não 403: a requisição está autorizada; é o alvo (política
 * `is_system` do seed) que é protegido.
 */
export type CodigoDeErroDeAbac =
  | 'politica-nao-encontrada' // 404
  | 'politica-conflito' // 409 — name de política já existe
  | 'politica-imutavel' // 409 — política is_system
  | 'condicao-invalida'; // 400 — condição fora da gramática fechada

export interface TraducaoDeErro {
  readonly status: number;
  readonly slug: string;
  readonly titulo: string;
}

export const TRADUCAO_DE_ERRO_DE_ABAC: Readonly<Record<CodigoDeErroDeAbac, TraducaoDeErro>> = {
  'politica-nao-encontrada': {
    status: 404,
    slug: 'policy-not-found',
    titulo: 'Política não encontrada',
  },
  'politica-conflito': {
    status: 409,
    slug: 'policy-already-exists',
    titulo: 'Política já existe',
  },
  'politica-imutavel': {
    status: 409,
    slug: 'system-policy-immutable',
    titulo: 'Política de sistema é imutável',
  },
  'condicao-invalida': {
    status: 400,
    slug: 'invalid-condition',
    titulo: 'Condição de política inválida',
  },
};

export class ErroDeAbac extends Error {
  public readonly codigo: CodigoDeErroDeAbac;

  constructor(codigo: CodigoDeErroDeAbac) {
    super(`ErroDeAbac: ${codigo}`);
    this.name = 'ErroDeAbac';
    this.codigo = codigo;
  }
}
