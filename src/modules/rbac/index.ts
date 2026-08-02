export { registrarRotasDeRbac, type DependenciasDasRotasDeRbac } from './routes/rbac.routes.js';
export { criarRbacService, type RbacService } from './services/rbac.service.js';
export { criarAssignmentService, type AssignmentService } from './services/assignment.service.js';
export {
  criarGuardsDeAutorizacao,
  satisfaz,
  type GuardsDeAutorizacao,
  type GuardDeAutorizacao,
} from './middleware/require-permission.js';
export {
  criarRepositorioDePapel,
  type RepositorioDePapel,
} from './repositories/role.repository.js';
export {
  criarRepositorioDePermissao,
  type RepositorioDePermissao,
} from './repositories/permission.repository.js';
export {
  criarRepositorioDeAssociacao,
  type RepositorioDeAssociacao,
} from './repositories/assignment.repository.js';
export {
  criarMedidorDeRbac,
  medidorDeRbacNulo,
  type MedidorDeRbac,
} from './metrics/rbac.metrics.js';
export { ErroDeRbac, type CodigoDeErroDeRbac } from './errors/rbac.errors.js';
