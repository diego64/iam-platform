export { registrarRotasDeJwks } from './routes/jwks.routes.js';
export {
  criarJwksService,
  type JwksService,
  type ConfiguracaoJwks,
} from './services/jwks.service.js';
export { criarRepositorioJwks, type RepositorioJwks } from './repositories/jwks.repository.js';
export { gerarParEd25519, type ParDeChaves } from './services/key-factory.js';
export {
  garantirChaveDeBootstrap,
  type OpcoesDeBootstrapDeChave,
} from './services/bootstrap-key.js';
export {
  criarMedidorDeJwks,
  medidorDeJwksNulo,
  type MedidorDeJwks,
} from './metrics/jwks.metrics.js';
export {
  criarKeyRotationService,
  type KeyRotationService,
  type ConfiguracaoDeRotacao,
  type MotivoDeRotacao,
} from './services/key-rotation.service.js';
export { criarAgendadorDeRotacao, type AgendadorDeRotacao } from './services/rotation-scheduler.js';
export { registrarRotasDeChaves } from './routes/keys-admin.routes.js';
export { ErroDeRotacao, type CodigoDeErroDeRotacao } from './errors/rotation.errors.js';
export type { ChaveJwks, JwkPublica, MetadadosDeChave, StatusDaChave } from './types/jwks.types.js';
