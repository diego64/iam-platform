export { registrarRotasDeAbac, type DependenciasDasRotasDeAbac } from './routes/abac.routes.js';
export { criarAbacService, type AbacService } from './services/abac.service.js';
export {
  criarMotorDePoliticas,
  TTL_DE_CACHE_PADRAO_MS,
  type MotorDePoliticas,
} from './services/policy-engine.js';
export { avaliarCondicao, resolverAtributo } from './services/condition-evaluator.js';
export {
  criarGuardsDePolitica,
  type GuardsDePolitica,
  type GuardDePolitica,
  type CarregadorDeRecurso,
} from './middleware/require-policy.js';
export {
  criarRepositorioDePolitica,
  type RepositorioDePolitica,
} from './repositories/policy.repository.js';
export {
  criarMedidorDeAbac,
  medidorDeAbacNulo,
  type MedidorDeAbac,
} from './metrics/abac.metrics.js';
export { ErroDeAbac, type CodigoDeErroDeAbac } from './errors/abac.errors.js';
export type {
  Condicao,
  ContextoDeDecisao,
  Decisao,
  Efeito,
  JsonValue,
  Politica,
} from './types/abac.types.js';
