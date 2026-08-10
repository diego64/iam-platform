/**
 * Responsabilidade: schemas Zod da borda HTTP das notificações.
 * Regras:
 *  - Importado só por `routes/` e `controllers/`.
 *  - **Corpo vazio e `.strict()`.** O destinatário nunca vem da requisição: um campo de
 *    endereço aqui transformaria a rota num relay de spam autenticado, e um campo de corpo
 *    desfaria a garantia de assunto literal.
 *  - A resposta é `.strict()` para que a mensagem do provedor não escape por descuido — o
 *    que sai é a causa do vocabulário fechado.
 */
import { z } from 'zod';
import { CAUSAS_DE_FALHA, MOTIVOS_DE_SUPRESSAO } from '../constants/tipos.js';

export const corpoDoTeste = z.object({}).strict();

export const resultadoDoTeste = z
  .object({
    transporte: z.enum(['log', 'http']),
    destinatarios: z.number().int().nonnegative(),
    // `suprimida` é desfecho próprio: a mensagem não saiu por decisão da plataforma, não
    // por falha de quem entrega. Quem lê precisa saber qual dos dois foi.
    resultado: z.enum(['ok', 'erro', 'suprimida']),
    duracao_ms: z.number().int().nonnegative(),
    causa: z.enum(CAUSAS_DE_FALHA).optional(),
    motivo: z.enum(MOTIVOS_DE_SUPRESSAO).optional(),
  })
  .strict();

export type ResultadoDoTeste = z.infer<typeof resultadoDoTeste>;
