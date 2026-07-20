/**
 * Responsabilidade: os fluxos de troca, esqueci e reset de senha — a lógica de domínio da
 * gerenciamento de senha. Orquestra hash, política, token de reset, histórico, revogação de sessão e
 * notificação, todos por injeção.
 * Regras:
 *  - Não conhece Fastify nem drivers de banco: recebe portas e serviços prontos.
 *  - Sinaliza falha lançando `ErroDeSenha` com código genérico; o controller mapeia para
 *    RFC 7807. Mensagens nunca ecoam a senha.
 *  - `solicitarReset` **nunca lança por e-mail inexistente** e paga custo equivalente no
 *    caminho de ausência, para não denunciar por resposta nem por timing.
 */
import { randomBytes } from 'node:crypto';
import type { ServicoDeSenha } from '../../../shared/crypto/password.service.js';
import type { RepositorioDeUsuario, UsuarioParaSenha } from '../interfaces/usuario.port.js';
import type { RepositorioDeTokenDeReset } from '../repositories/reset-token.repository.js';
import type { RepositorioDeHistoricoDeSenha } from '../interfaces/historico.port.js';
import type { RevogadorDeSessoes } from '../interfaces/sessoes.port.js';
import type { CanalDeNotificacao } from '../interfaces/notificacao.port.js';
import { avaliarPolitica } from '../validators/politica.js';
import { ErroDeSenha } from '../errors/password-error.js';

export interface DependenciasDeSenha {
  readonly servicoDeSenha: ServicoDeSenha;
  readonly usuarios: RepositorioDeUsuario;
  readonly tokensDeReset: RepositorioDeTokenDeReset;
  readonly historico: RepositorioDeHistoricoDeSenha;
  readonly sessoes: RevogadorDeSessoes;
  readonly notificacao: CanalDeNotificacao;
  /** Validade do token de reset, em minutos. */
  readonly ttlResetMin: number;
  /** Quantas senhas anteriores bloquear, para impedir que o usuário volte a uma recente. */
  readonly historicoN: number;
}

export interface PasswordService {
  trocar(entrada: { userId: string; senhaAtual: string; senhaNova: string }): Promise<void>;
  solicitarReset(entrada: { email: string; ipOrigem?: string }): Promise<void>;
  confirmarReset(entrada: { token: string; senhaNova: string }): Promise<void>;
}

export function criarPasswordService(deps: DependenciasDeSenha): PasswordService {
  const { servicoDeSenha, usuarios, tokensDeReset, historico, sessoes, notificacao } = deps;

  /** Valida política com contexto do e-mail; lança `politica` no primeiro motivo. */
  function exigirPolitica(senha: string, email: string): void {
    const resultado = avaliarPolitica(senha, { email });
    if (!resultado.ok) throw new ErroDeSenha('politica', resultado.motivo);
  }

  /**
   * Lança `reuso` se a nova senha é igual à atual ou a uma das últimas N já usadas.
   *
   * Cada comparação é um `scrypt` — a checagem de histórico custa N derivações. É a razão
   * de o caminho de troca ser mais pesado que um hash único: um SLO de latência para a
   * troca precisa contar essas N derivações, não só a geração do novo hash.
   */
  async function exigirNaoReuso(
    userId: string,
    senhaNova: string,
    hashAtual: string,
  ): Promise<void> {
    if (await servicoDeSenha.verificar(senhaNova, hashAtual)) {
      throw new ErroDeSenha('reuso');
    }
    for (const hashAntigo of await historico.ultimosHashes(userId, deps.historicoN)) {
      if (await servicoDeSenha.verificar(senhaNova, hashAntigo)) {
        throw new ErroDeSenha('reuso');
      }
    }
  }

  /** Aplica a nova senha: grava o hash, registra no histórico, revoga sessões e resets. */
  async function aplicarNovaSenha(usuario: UsuarioParaSenha, senhaNova: string): Promise<void> {
    const novoHash = await servicoDeSenha.gerarHash(senhaNova);
    await usuarios.atualizarHash(usuario.id, novoHash);
    await historico.registrar(usuario.id, novoHash);
    await sessoes.revogarTodas(usuario.id);
    await tokensDeReset.invalidarDoUsuario(usuario.id);
  }

  return {
    async trocar({ userId, senhaAtual, senhaNova }): Promise<void> {
      const usuario = await usuarios.buscarPorId(userId);
      // Usuário autenticado que sumiu, ou senha atual errada: mesma resposta genérica.
      if (usuario === null || !(await servicoDeSenha.verificar(senhaAtual, usuario.passwordHash))) {
        throw new ErroDeSenha('credencial-invalida');
      }

      exigirPolitica(senhaNova, usuario.email);
      await exigirNaoReuso(userId, senhaNova, usuario.passwordHash);
      await aplicarNovaSenha(usuario, senhaNova);
    },

    async solicitarReset({ email, ipOrigem }): Promise<void> {
      const usuario = await usuarios.buscarPorEmail(email);

      if (usuario === null || usuario.status !== 'active') {
        // Paga o custo de um scrypt contra o hash fantasma: o caminho "não existe" leva o
        // mesmo tempo do legítimo e não denuncia a ausência por timing.
        await servicoDeSenha.verificar('anti-timing', await servicoDeSenha.hashFantasma());
        return;
      }

      const token = randomBytes(32).toString('base64url');
      const expiraEm = new Date(Date.now() + deps.ttlResetMin * 60_000);
      await tokensDeReset.registrar({
        token,
        userId: usuario.id,
        expiraEm,
        ...(ipOrigem === undefined ? {} : { ipOrigem }),
      });
      await notificacao.enviarReset(email, token);
    },

    async confirmarReset({ token, senhaNova }): Promise<void> {
      // Busca sem consumir: senha reprovada não pode queimar o token.
      const alvo = await tokensDeReset.buscarValido(token);
      if (alvo === null) throw new ErroDeSenha('token-invalido');

      const usuario = await usuarios.buscarPorId(alvo.userId);
      if (usuario === null) throw new ErroDeSenha('token-invalido');

      exigirPolitica(senhaNova, usuario.email);
      await exigirNaoReuso(usuario.id, senhaNova, usuario.passwordHash);

      // Só agora consome, de forma atômica: fecha a corrida entre dois resets com o mesmo
      // token. Perdeu a corrida (ou expirou nesse meio-tempo) ⇒ token inválido.
      const consumido = await tokensDeReset.consumir(token);
      if (consumido === null) throw new ErroDeSenha('token-invalido');

      await aplicarNovaSenha(usuario, senhaNova);
    },
  };
}
