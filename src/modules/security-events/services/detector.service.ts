/**
 * Responsabilidade: aplicar as regras a cada fato auditado, respeitar o silêncio, persistir
 * o juízo, medir e alertar.
 * Consumido por: o decorador da porta de auditoria.
 * Regras:
 *  - **Nada escapa daqui.** `observar` nunca lança e nunca rejeita: ele roda fora do caminho
 *    da requisição, e um erro solto viraria rejeição não tratada no processo.
 *  - **Uma regra que quebra não cega as outras.** Cada uma roda isolada; a que falhar conta
 *    erro e as demais seguem. Sem isso, um `null` inesperado numa regra apagaria a detecção
 *    inteira, e ninguém perceberia — é justamente o tipo de falha silenciosa que a métrica
 *    de erro existe para denunciar.
 *  - **Silêncio por (regra, sujeito), reivindicado e não consultado.** Depois de disparar,
 *    aquela combinação fica muda por um período. Sem freio, um ataque em curso emite alarme
 *    a cada tentativa e o canal vira fluxo — ninguém lê o segundo aviso. E como a detecção
 *    roda solta, a decisão é por incremento atômico: consultar antes de marcar deixaria uma
 *    rajada inteira passar pela janela entre a leitura e a escrita.
 *  - A ordem é: reivindica, persiste, mede, alerta. Alertar antes de persistir deixaria um
 *    aviso apontando para um evento que não existe se a escrita falhar.
 */
import { medidorDeSegurancaNulo, type MedidorDeSeguranca } from '../metrics/security.metrics.js';
import { canalNulo, type CanalDeAlerta } from '../interfaces/alerta.port.js';
import { REGRAS_PADRAO, type ContextoDeRegra, type RegraDeDeteccao } from './regras/index.js';
import type { EventoDeAuditoria } from '../../audit/types/audit-event.js';
import type { Deteccao } from '../types/security-event.js';
import type { RepositorioDeEventosDeSeguranca } from '../repositories/security-event.repository.js';
import type { ContadorDeRateLimit } from '../../../shared/rate-limit/types.js';

export interface DependenciasDoDetector {
  readonly contexto: ContextoDeRegra;
  readonly eventos: RepositorioDeEventosDeSeguranca;
  /** Mesmo contador das janelas; aqui guarda o silêncio por (regra, sujeito). */
  readonly silencio: ContadorDeRateLimit;
  readonly silencioMs: number;
  readonly retencaoMs: number;
  readonly canal?: CanalDeAlerta;
  readonly medidor?: MedidorDeSeguranca;
  readonly aoFalhar?: (contexto: { regra: string; erro: unknown }) => void;
  /** Correlação com a requisição que fechou o limiar. */
  readonly traceIdAtual?: () => string | null;
  readonly regras?: readonly RegraDeDeteccao[];
  readonly agora?: () => number;
}

export interface Detector {
  /** Oferece o fato às regras. Nunca lança, nunca rejeita. */
  observar(evento: EventoDeAuditoria): Promise<void>;
}

export function criarDetector(deps: DependenciasDoDetector): Detector {
  const medidor = deps.medidor ?? medidorDeSegurancaNulo();
  const canal = deps.canal ?? canalNulo();
  const regras = deps.regras ?? REGRAS_PADRAO;
  const agora = deps.agora ?? Date.now;

  function chaveDeSilencio(deteccao: Deteccao): string {
    return `sil:${deteccao.regra}:${deteccao.sujeito.pista}`;
  }

  /**
   * Reivindica o direito de alarmar por esta combinação, e devolve `true` para quem venceu.
   *
   * É incremento-e-compara, não leitura-e-decisão: a detecção roda solta, então uma rajada
   * produz várias execuções concorrentes, e todas leriam "não silenciado" antes de qualquer
   * uma escrever. Só o primeiro incremento devolve 1 — os outros já veem o próprio efeito
   * dos vizinhos.
   *
   * Contador indisponível reivindica: prefere-se avisar de novo a engolir um alarme, porque
   * ruído é recuperável e alarme perdido não.
   */
  async function reivindicar(deteccao: Deteccao): Promise<boolean> {
    const estado = await deps.silencio.incrementar(chaveDeSilencio(deteccao), deps.silencioMs);
    return estado === null || estado.contagem === 1;
  }

  async function registrar(deteccao: Deteccao): Promise<void> {
    const instante = new Date(agora());
    const evento = await deps.eventos.anexar({
      ...deteccao,
      // A janela é a melhor aproximação de quando a rajada começou: as ocorrências
      // individuais vivem na trilha, não aqui.
      primeiraEm: new Date(instante.getTime() - deteccao.janelaMs),
      ultimaEm: instante,
      traceId: deps.traceIdAtual?.() ?? null,
      expiraEm: new Date(instante.getTime() + deps.retencaoMs),
    });

    medidor.contarEvento(deteccao.regra, deteccao.severidade);
    // O canal não pode impedir o registro: o evento já está gravado quando o aviso sai.
    await canal.alertar(evento);
  }

  return {
    async observar(evento: EventoDeAuditoria): Promise<void> {
      const inicio = agora();

      for (const regra of regras) {
        try {
          const deteccao = await regra(evento, deps.contexto);
          if (deteccao === null) continue;
          // Reivindica antes de agir: quem não venceu não alarma.
          if (!(await reivindicar(deteccao))) continue;
          await registrar(deteccao);
        } catch (erro) {
          // Isolada de propósito: a próxima regra ainda tem chance de ver o mesmo fato.
          medidor.contarErro();
          deps.aoFalhar?.({ regra: 'desconhecida', erro });
        }
      }

      medidor.observarDeteccao((agora() - inicio) / 1000);
    },
  };
}
