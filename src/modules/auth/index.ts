export { registrarRotasDeAuth, type DependenciasDasRotasDeAuth } from './routes/auth.routes.js';
export { criarAuthService, type AuthService } from './services/auth.service.js';
export { criarTokenService, type TokenService } from './services/token.service.js';
export {
  criarRepositorioDeAutenticacao,
  type RepositorioDeAutenticacao,
} from './repositories/auth-user.repository.js';
export {
  criarRepositorioDeDenylist,
  type RepositorioDeDenylist,
} from './repositories/token-denylist.repository.js';
export {
  criarVerificadorDeAccessToken,
  idAutenticado,
  type VerificadorDeAccessToken,
} from './middleware/verify-access-token.js';
export {
  criarMedidorDeAuth,
  medidorDeAuthNulo,
  type MedidorDeAuth,
} from './metrics/auth.metrics.js';
export { criarRefreshTokenStub } from './services/refresh-token.stub.js';
export type { PortaDeRefreshToken } from './interfaces/refresh-token.port.js';
