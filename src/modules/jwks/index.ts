export { registrarRotasDeJwks } from './routes/jwks.routes.js';
export {
  criarJwksService,
  type JwksService,
  type ConfiguracaoJwks,
} from './services/jwks.service.js';
export { criarRepositorioJwks, type RepositorioJwks } from './repositories/jwks.repository.js';
export { gerarParEd25519, type ParDeChaves } from './services/key-factory.js';
export {
  criarMedidorDeJwks,
  medidorDeJwksNulo,
  type MedidorDeJwks,
} from './metrics/jwks.metrics.js';
export type { ChaveJwks, JwkPublica, StatusDaChave } from './types/jwks.types.js';
