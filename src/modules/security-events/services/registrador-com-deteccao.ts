/**
 * Responsabilidade: ligar a detecção à porta de auditoria sem que nenhum emissor saiba.
 * Consumido por: a composição, que injeta este no lugar do registrador direto.
 * Regras:
 *  - Implementa `RegistradorDeAuditoria` e delega. Sete módulos já passam por essa porta;
 *    decorá-la é o que faz o oitavo — o que alguém escrever daqui a três meses — entrar de
 *    graça, em vez de precisar lembrar de chamar o detector.
 *  - **O fato é aguardado; o juízo não.** A trilha é o registro do qual tudo depende e
 *    precisa terminar antes de a operação seguir. A detecção roda solta: somar duas idas ao
 *    Mongo por evento colocaria a correlação no caminho crítico do login, e o custo
 *    apareceria no p95 de quem só quer entrar.
 *  - **Trade-off aceito:** um alarme pode se perder se o processo morrer entre as duas
 *    coisas. O fato já está na trilha e a detecção é derivável de novo; perder um aviso num
 *    encerramento é menos grave que somar latência a todo login.
 *  - `registrar` continua nunca lançando — nem quando a detecção explode.
 */
import type { RegistradorDeAuditoria } from '../../audit/interfaces/audit-recorder.js';
import type { EventoDeAuditoria } from '../../audit/types/audit-event.js';
import type { Detector } from './detector.service.js';

export function criarRegistradorComDeteccao(
  base: RegistradorDeAuditoria,
  detector: Detector,
): RegistradorDeAuditoria {
  return {
    async registrar(evento: EventoDeAuditoria): Promise<void> {
      await base.registrar(evento);

      // Sem `await`: a requisição que gerou o fato não espera pelo juízo. O `catch` existe
      // porque uma promessa solta que rejeita derruba o processo no Node.
      void detector.observar(evento).catch(() => {
        /* o detector já engole e mede o próprio erro; aqui é só a rede de segurança */
      });
    },
  };
}
