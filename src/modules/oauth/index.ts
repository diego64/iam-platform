export { registrarRotasDeOAuth, type DependenciasDasRotasDeOAuth } from './routes/oauth.routes.js';
export {
  registrarRotasDeMetadados,
  type DependenciasDasRotasDeMetadados,
} from './routes/metadata.routes.js';
export {
  criarMetadataService,
  type MetadataService,
  type MetadadosDoServidor,
} from './services/metadata.service.js';
export {
  criarMedidorDeOAuth,
  medidorDeOAuthNulo,
  type MedidorDeOAuth,
} from './metrics/oauth.metrics.js';
export {
  criarOAuthService,
  type OAuthService,
  type DependenciasDoOAuthService,
  type PedidoDeToken,
  type TokenConcedido,
} from './services/oauth.service.js';
export {
  calcularEscopoConcedido,
  formatarEscopo,
  type EntradaDeEscopo,
} from './services/scope-grant.js';
export {
  extrairCredencialDeCliente,
  type CredencialDeCliente,
} from './services/client-credentials.js';
export { ErroDeOAuth, type CodigoDeErroOAuth } from './errors/oauth-error.js';
