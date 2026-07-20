/**
 * Responsabilidade: o refinement Zod da senha, para a borda HTTP.
 * Consumido por: `routes/`/`controllers/` desta SPEC e reexportado para a 002 usar na
 * criação de usuário.
 * Regras:
 *  - Delega a regra ao validador de domínio (`avaliarPolitica`) — o Zod é só o adaptador
 *    de borda, a política mora no domínio e não é duplicada aqui.
 *  - As regras dependentes de contexto (senha contém o e-mail) ficam para o serviço, que
 *    tem o e-mail em mãos; o schema cobre comprimento, classes e blocklist.
 */
import { z } from 'zod';
import { avaliarPolitica, mensagemDeRejeicao } from '../validators/politica.js';

export const senhaForte = z.string().superRefine((valor, ctx) => {
  const resultado = avaliarPolitica(valor);
  if (!resultado.ok) {
    // A mensagem vem do domínio e nunca ecoa o valor recebido.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: mensagemDeRejeicao(resultado.motivo) });
  }
});
