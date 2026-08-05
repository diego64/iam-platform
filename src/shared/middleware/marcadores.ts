/**
 * Responsabilidade: marcar um `preHandler` pelo papel que ele cumpre — autenticar ou
 * autorizar — para que uma verificação automática consiga distingui-los.
 * Consumido por: o verificador de access token, os guards de autorização e a checagem de
 * boot que impede uma rota administrativa de subir desprotegida.
 * Regras:
 *  - Símbolo, não nome de função: nome muda em refatoração e sobrevive a minificação de
 *    formas imprevisíveis; a marca é uma propriedade que só este arquivo sabe criar.
 *  - Marcar não protege nada por si. A marca é a etiqueta que permite **verificar** se a
 *    proteção existe; quem protege continua sendo o próprio handler.
 */

const MARCA_AUTENTICACAO = Symbol.for('iam.preHandler.autenticacao');
const MARCA_AUTORIZACAO = Symbol.for('iam.preHandler.autorizacao');

type Marcavel = { [chave: symbol]: boolean | undefined };

function marcar<T extends object>(handler: T, marca: symbol): T {
  Object.defineProperty(handler, marca, { value: true, enumerable: false });
  return handler;
}

/** Marca o handler que verifica o token e popula o usuário da requisição. */
export function marcarAutenticacao<T extends object>(handler: T): T {
  return marcar(handler, MARCA_AUTENTICACAO);
}

/** Marca o handler que decide se o já-autenticado pode executar a rota. */
export function marcarAutorizacao<T extends object>(handler: T): T {
  return marcar(handler, MARCA_AUTORIZACAO);
}

function temMarca(handler: unknown, marca: symbol): boolean {
  return typeof handler === 'function' && (handler as unknown as Marcavel)[marca] === true;
}

export function ehAutenticacao(handler: unknown): boolean {
  return temMarca(handler, MARCA_AUTENTICACAO);
}

export function ehAutorizacao(handler: unknown): boolean {
  return temMarca(handler, MARCA_AUTORIZACAO);
}
