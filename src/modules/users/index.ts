export { registrarRotasDeUsuario } from './routes/user.routes.js';
export { criarUserService } from './services/user.service.js';
export { criarRepositorioDeUsuario } from './repositories/user.repository.js';
export { criarMedidorDeUsuarios } from './metrics/users.metrics.js';
export { garantirAdminDeBootstrap } from './services/bootstrap-admin.js';
export type { DependenciasDoController } from './controllers/user.controller.js';
export type { RepositorioDeUsuario } from './repositories/user.repository.js';
export type { AutorizadorAdmin } from './interfaces/autorizador-admin.port.js';
export type { RevogadorDeSessoes } from './interfaces/sessoes.port.js';
