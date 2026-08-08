export {
  registrarRotasDeAuditoria,
  type DependenciasDasRotasDeAuditoria,
} from './routes/audit.routes.js';
export { criarAuditService, type DependenciasDoAuditService } from './services/audit.service.js';
export { criarAuditQueryService, type AuditQueryService } from './services/audit-query.service.js';
export {
  criarAuditIntegrityService,
  type AuditIntegrityService,
  type RelatorioDeIntegridade,
} from './services/audit-integrity.service.js';
export { calcularHashDoElo, corpoDe } from './services/chain-hash.js';
export {
  criarRepositorioDaTrilha,
  ErroDeContencaoDaCadeia,
  type RepositorioDaTrilha,
} from './repositories/audit-log.repository.js';
export {
  criarRepositorioDeCheckpoint,
  type Checkpoint,
  type RepositorioDeCheckpoint,
} from './repositories/audit-checkpoint.repository.js';
export { registradorNulo, type RegistradorDeAuditoria } from './interfaces/audit-recorder.js';
export {
  criarMedidorDeAuditoria,
  medidorDeAuditoriaNulo,
  type MedidorDeAuditoria,
} from './metrics/audit.metrics.js';
export { ErroDeAuditoria, type CodigoDeErroDeAuditoria } from './errors/audit.errors.js';
export { TIPOS_DE_EVENTO, ehTipoDeEvento, type TipoDeEvento } from './constants/event-types.js';
export type { EventoDeAuditoria, EventoPersistido } from './types/audit-event.js';
