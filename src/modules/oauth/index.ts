export { registrarRotasDeOAuth, type DependenciasDasRotasDeOAuth } from './routes/oauth.routes.js';
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
