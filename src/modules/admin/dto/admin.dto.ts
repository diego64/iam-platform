/**
 * Responsabilidade: converter as visões do painel no que a API devolve.
 * Regras: campo a campo, sem espalhar objeto de origem. É a última barreira antes de a
 * resposta sair, e ela precisa continuar valendo quando alguém acrescentar um campo interno
 * numa porta lá atrás.
 */
import type { VisaoGeral } from '../services/overview.service.js';
import type { FichaDeUsuario } from '../services/user-view.service.js';
import type { SessaoDeUsuario } from '../interfaces/portas.js';

export function sessaoParaDTO(sessao: SessaoDeUsuario): Record<string, unknown> {
  return {
    session_id: sessao.sessionId,
    created_at: sessao.criadaEm.toISOString(),
    expires_at: sessao.expiraEm.toISOString(),
    ...(sessao.ip === undefined ? {} : { ip: sessao.ip }),
    ...(sessao.userAgent === undefined ? {} : { user_agent: sessao.userAgent }),
    ...(sessao.vistaPorUltimoEm === undefined
      ? {}
      : { last_seen_at: sessao.vistaPorUltimoEm.toISOString() }),
  };
}

export function visaoGeralParaDTO(visao: VisaoGeral, doCache: boolean): Record<string, unknown> {
  return {
    apurado_em: visao.apuradoEm.toISOString(),
    cache: doCache ? 'hit' : 'miss',
    parcial: visao.parcial,
    usuarios: visao.usuarios,
    sessoes_ativas: visao.sessoesAtivas,
    logins_24h: visao.logins24h,
    clientes_ativos: visao.clientesAtivos,
    chave_ativa:
      visao.chaveAtiva === null
        ? null
        : { kid: visao.chaveAtiva.kid, idade_dias: visao.chaveAtiva.idadeDias },
  };
}

export function fichaParaDTO(ficha: FichaDeUsuario): Record<string, unknown> {
  return {
    parcial: ficha.parcial,
    perfil: {
      id: ficha.perfil.id,
      email: ficha.perfil.email,
      status: ficha.perfil.status,
      created_at: ficha.perfil.criadoEm.toISOString(),
      updated_at: ficha.perfil.atualizadoEm.toISOString(),
    },
    papeis:
      ficha.papeis?.map((papel) => ({
        id: papel.id,
        name: papel.name,
        is_system: papel.isSystem,
      })) ?? null,
    permissoes: ficha.permissoes,
    senha:
      ficha.senha === null ? null : { alterada_em: ficha.senha.alteradaEm?.toISOString() ?? null },
    sessoes: ficha.sessoes?.map(sessaoParaDTO) ?? null,
    eventos:
      ficha.eventos?.map((evento) => ({
        seq: evento.seq,
        type: evento.type,
        occurred_at: evento.occurredAt.toISOString(),
        outcome: evento.outcome,
      })) ?? null,
  };
}
