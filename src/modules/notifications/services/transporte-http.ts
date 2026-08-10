/**
 * Responsabilidade: entregar a mensagem ao provedor de e-mail por HTTP.
 * Consumido por: a composição, quando `NOTIFY_TRANSPORT=http`.
 * Regras:
 *  - `fetch` nativo do Node, sem dependência nova. SMTP traria conexão persistente, pool,
 *    retry e diagnóstico próprios — máquina que não se quer manter para mandar punhados de
 *    mensagem por hora. Trocar de provedor é reescrever este arquivo, e só ele.
 *  - **O corpo da resposta de erro não é lido nem registrado.** Provedor costuma ecoar a
 *    requisição no erro, e a requisição contém o destinatário e — no reset — o token.
 *  - **Timeout sempre.** Sem ele, um provedor lento não derruba o processo: acumula promessas
 *    presas, que é a mesma coisa mais devagar.
 *  - **Sem retry.** Reenviar exige saber o que falhou, o que exige guardar o que saiu; a
 *    decisão desta SPEC é não guardar. Falha vira contador e log, e o alerta é da SPEC 022.
 *  - Nunca lança: devolve a causa, do vocabulário fechado.
 */
import type { TransportadorDeEmail, ResultadoDeEntrega } from '../interfaces/transporte.port.js';
import type { MensagemDeEmail } from '../types/mensagem.js';

export interface OpcoesDoTransporteHttp {
  readonly url: string;
  readonly token: string;
  readonly remetente: string;
  readonly timeoutMs: number;
  /** Recebe só o erro; o que vira log é decisão de quem injeta, e ele não vê a mensagem. */
  readonly aoFalhar?: (erro: unknown) => void;
}

/** `AbortError` do `AbortSignal.timeout` — o único erro que se distingue dos demais. */
function ehTimeout(erro: unknown): boolean {
  return erro instanceof Error && (erro.name === 'TimeoutError' || erro.name === 'AbortError');
}

export function criarTransporteHttp(opcoes: OpcoesDoTransporteHttp): TransportadorDeEmail {
  return {
    async enviar(mensagem: MensagemDeEmail): Promise<ResultadoDeEntrega> {
      try {
        const resposta = await fetch(opcoes.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opcoes.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: opcoes.remetente,
            to: mensagem.para,
            subject: mensagem.assunto,
            text: mensagem.texto,
            html: mensagem.html,
          }),
          signal: AbortSignal.timeout(opcoes.timeoutMs),
        });

        if (resposta.ok) return { ok: true };

        // 4xx é configuração ou endereço ruim; 5xx é o provedor. A distinção importa para
        // quem investiga, e é tudo o que se pode dizer sem ler o corpo.
        opcoes.aoFalhar?.(new Error(`provedor respondeu ${String(resposta.status)}`));
        return { ok: false, causa: resposta.status < 500 ? 'recusado' : 'indisponivel' };
      } catch (erro) {
        opcoes.aoFalhar?.(erro);
        return { ok: false, causa: ehTimeout(erro) ? 'timeout' : 'indisponivel' };
      }
    },
  };
}
