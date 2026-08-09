export {
  registrarRotasDeSeguranca,
  type DependenciasDasRotasDeSeguranca,
} from './routes/security.routes.js';
export {
  criarDetector,
  type Detector,
  type DependenciasDoDetector,
} from './services/detector.service.js';
export { criarRegistradorComDeteccao } from './services/registrador-com-deteccao.js';
export { criarExtratorDeSujeito, type ExtratorDeSujeito } from './services/sujeito.js';
export { criarCanalDeLog } from './services/canal-de-log.js';
export { canalNulo, type CanalDeAlerta } from './interfaces/alerta.port.js';
export {
  REGRAS_PADRAO,
  type ContextoDeRegra,
  type LimiaresDeDeteccao,
} from './services/regras/index.js';
export {
  criarRepositorioDeEventosDeSeguranca,
  type RepositorioDeEventosDeSeguranca,
} from './repositories/security-event.repository.js';
export {
  criarRepositorioDeConjuntoDistinto,
  type RepositorioDeConjuntoDistinto,
} from './repositories/distinct-set.repository.js';
export {
  criarMedidorDeSeguranca,
  medidorDeSegurancaNulo,
  type MedidorDeSeguranca,
} from './metrics/security.metrics.js';
export { REGRAS, SEVERIDADES, type Regra, type Severidade } from './constants/regras.js';
export type { EventoDeSeguranca } from './types/security-event.js';
