/**
 * Responsabilidade: traduzir os nomes de escopo pedidos para os ids de permissão que o
 * repositório grava, recusando o que não existe.
 * Consumido por: o serviço de clientes, na criação e na troca de escopos.
 * Regras:
 *  - Escopo inexistente é recusa, não silêncio. Ignorar o desconhecido criaria um cliente
 *    que parece ter a autoridade pedida e não tem — descoberto só quando uma chamada dele
 *    for negada em produção.
 *  - O curinga `*` nunca é concedível a um cliente, por ninguém. Ele existe como permissão
 *    semeada para o papel de superadministração; um cliente que o recebesse passaria por
 *    qualquer verificação do guard, e clientes não têm nem sessão nem MFA para sustentar
 *    esse nível de poder.
 */
import { ErroDeCliente } from '../errors/api-client.errors.js';
import type { CatalogoDeEscopos } from '../repositories/scope-catalog.repository.js';

const CURINGA = '*';

export interface ResolvedorDeEscopos {
  /** @throws {ErroDeCliente} `curinga-proibido` ou `escopo-desconhecido`. */
  resolver(nomes: readonly string[]): Promise<string[]>;
}

export function criarResolvedorDeEscopos(catalogo: CatalogoDeEscopos): ResolvedorDeEscopos {
  return {
    async resolver(nomes: readonly string[]): Promise<string[]> {
      if (nomes.includes(CURINGA)) {
        throw new ErroDeCliente('curinga-proibido');
      }

      // Duplicatas no pedido não são erro — o conjunto é o que importa, e a chave composta
      // da tabela recusaria a repetição de qualquer forma.
      const pedidos = [...new Set(nomes)];
      const encontrados = await catalogo.idsPorNome(pedidos);

      const ausentes = pedidos.filter((nome) => !encontrados.has(nome));
      if (ausentes.length > 0) {
        throw new ErroDeCliente('escopo-desconhecido', ausentes);
      }

      return pedidos.map((nome) => encontrados.get(nome) as string);
    },
  };
}
