/**
 * Responsabilidade: a ficha de um usuário — perfil, papéis, permissões efetivas, sessões
 * ativas, estado da senha e os últimos eventos — numa chamada só.
 * Consumido por: o controller do painel administrativo.
 * Regras:
 *  - O usuário é verificado primeiro. Não existindo, a resposta é 404 antes de qualquer
 *    outra consulta: agregar o resto seria trabalho jogado fora e ainda produziria uma ficha
 *    vazia que parece um usuário sem nada.
 *  - As demais fontes são acessórias: cada uma que falha vira campo nulo com `parcial: true`.
 *  - O que sai daqui é montado campo a campo. Hash de senha, hash de token e segredo de
 *    cliente não têm caminho até esta resposta, e não é por lembrança de removê-los: as
 *    portas nunca os trazem.
 */
import { ErroDeAdmin } from '../errors/admin.errors.js';
import type {
  EventoResumido,
  LeitorDeAuditoria,
  LeitorDeAutorizacao,
  LeitorDeSenha,
  LeitorDeSessoes,
  LeitorDeUsuarios,
  PapelDoUsuario,
  PerfilDeUsuario,
  SessaoDeUsuario,
} from '../interfaces/portas.js';

export interface FichaDeUsuario {
  readonly parcial: boolean;
  readonly perfil: PerfilDeUsuario;
  readonly papeis: PapelDoUsuario[] | null;
  readonly permissoes: string[] | null;
  readonly senha: { readonly alteradaEm: Date | null } | null;
  readonly sessoes: SessaoDeUsuario[] | null;
  readonly eventos: EventoResumido[] | null;
}

export interface DependenciasDaFicha {
  readonly usuarios: LeitorDeUsuarios;
  readonly autorizacao: LeitorDeAutorizacao;
  readonly sessoes: LeitorDeSessoes;
  readonly auditoria: LeitorDeAuditoria;
  readonly senha: LeitorDeSenha;
  readonly limiteDeEventos: number;
  readonly medidor?: { contarParcial(fonte: string): void };
}

export interface UserViewService {
  obter(userId: string): Promise<FichaDeUsuario>;
}

function valorDe<T>(resultado: PromiseSettledResult<T>): T | null {
  return resultado.status === 'fulfilled' ? resultado.value : null;
}

export function criarUserViewService(deps: DependenciasDaFicha): UserViewService {
  return {
    async obter(userId: string): Promise<FichaDeUsuario> {
      let perfil: PerfilDeUsuario | null;
      try {
        perfil = await deps.usuarios.buscarPorId(userId);
      } catch {
        throw new ErroDeAdmin('fonte-essencial-indisponivel');
      }
      if (perfil === null) throw new ErroDeAdmin('usuario-nao-encontrado');

      const [papeis, permissoes, sessoes, eventos, alteradaEm] = await Promise.allSettled([
        deps.autorizacao.papeisDoUsuario(userId),
        deps.autorizacao.permissoesEfetivas(userId),
        deps.sessoes.listarDoUsuario(userId),
        deps.auditoria.ultimosDoUsuario(userId, deps.limiteDeEventos),
        deps.senha.alteradaEm(userId),
      ]);

      const fontes: [string, boolean][] = [
        ['autorizacao', papeis.status === 'rejected' || permissoes.status === 'rejected'],
        ['sessoes', sessoes.status === 'rejected'],
        ['auditoria', eventos.status === 'rejected'],
        ['senha', alteradaEm.status === 'rejected'],
      ];
      for (const [fonte, faltou] of fontes) {
        if (faltou) deps.medidor?.contarParcial(fonte);
      }

      return {
        parcial: fontes.some(([, faltou]) => faltou),
        perfil: {
          id: perfil.id,
          email: perfil.email,
          status: perfil.status,
          criadoEm: perfil.criadoEm,
          atualizadoEm: perfil.atualizadoEm,
        },
        papeis: valorDe(papeis),
        permissoes: valorDe(permissoes),
        senha: alteradaEm.status === 'fulfilled' ? { alteradaEm: alteradaEm.value } : null,
        sessoes: valorDe(sessoes),
        eventos: valorDe(eventos),
      };
    },
  };
}
