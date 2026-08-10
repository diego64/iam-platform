export {
  registrarRotasDeNotificacoes,
  LIMITE_TESTE,
  type DependenciasDasRotasDeNotificacoes,
} from './routes/notifications.routes.js';
export {
  criarServicoDeNotificacao,
  type ServicoDeNotificacao,
  type DependenciasDoServicoDeNotificacao,
} from './services/notification.service.js';
export {
  criarNotificador,
  criarRegistradorComNotificacao,
  type DependenciasDaNotificacao,
} from './services/registrador-com-notificacao.js';
export { criarCanalDeReset, type OpcoesDoCanalDeReset } from './services/canal-de-reset.js';
export { criarCanalDeEmail, type OpcoesDoCanalDeEmail } from './services/canal-de-email.js';
export { criarTransporteHttp, type OpcoesDoTransporteHttp } from './services/transporte-http.js';
export { criarTransporteDeLog, digestDeEndereco } from './services/transporte-de-log.js';
export {
  criarRepositorioDeDispositivos,
  prefixoDeRede,
  type RepositorioDeDispositivos,
} from './repositories/known-device.repository.js';
export { criarResolvedorDeDestinatario } from './repositories/recipient.repository.js';
export type { ResolvedorDeDestinatario } from './interfaces/destinatario.port.js';
export {
  transporteNulo,
  type TransportadorDeEmail,
  type ResultadoDeEntrega,
} from './interfaces/transporte.port.js';
export {
  criarMedidorDeNotificacoes,
  medidorDeNotificacoesNulo,
  type MedidorDeNotificacoes,
} from './metrics/notifications.metrics.js';
export {
  TIPOS_DE_NOTIFICACAO,
  type MotivoDeSupressao,
  type TipoDeNotificacao,
} from './constants/tipos.js';
