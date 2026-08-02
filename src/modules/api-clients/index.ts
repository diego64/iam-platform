export { registrarRotasDeClientes } from './routes/api-client.routes.js';
export {
  criarApiClientService,
  type ApiClientService,
  type ConfiguracaoDeClientes,
} from './services/api-client.service.js';
export {
  criarClientAuthService,
  type ClientAuthService,
  type ConfiguracaoDeAutenticacaoDeCliente,
} from './services/client-auth.service.js';
export { criarResolvedorDeEscopos, type ResolvedorDeEscopos } from './services/scope-resolver.js';
export { gerarClientId, gerarSegredo } from './services/credential-factory.js';
export {
  criarRepositorioDeClientes,
  type RepositorioDeClientes,
} from './repositories/api-client.repository.js';
export {
  criarCatalogoDeEscopos,
  type CatalogoDeEscopos,
} from './repositories/scope-catalog.repository.js';
export {
  criarMedidorDeClientes,
  medidorDeClientesNulo,
  type MedidorDeClientes,
  type MotivoDeFalhaDeCliente,
} from './metrics/api-clients.metrics.js';
export { ErroDeCliente, type CodigoDeErroDeCliente } from './errors/api-client.errors.js';
export type {
  ClienteAutenticado,
  ClienteDeApi,
  CredenciaisDoCliente,
  StatusDoCliente,
  TipoDeGrant,
} from './types/api-client.types.js';
