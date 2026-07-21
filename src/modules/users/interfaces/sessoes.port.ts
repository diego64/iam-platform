/**
 * Porta de revogação de sessões, chamada ao bloquear ou remover um usuário.
 *
 * Bloquear sem derrubar as sessões vivas deixaria um Access Token válido por até 15 min
 * depois do bloqueio (a 001 depende deste comportamento — RF-05 de lá). O contrato é o
 * mesmo que a 009 já declarou; a 002 mantém uma cópia local de uma linha para não acoplar
 * um módulo ao interno do outro. A composição raiz injeta o mesmo concreto (001/006) nos
 * dois; aqui roda contra um fake.
 */
export interface RevogadorDeSessoes {
  revogarTodas(userId: string): Promise<void>;
}
