// Verificação do segundo fator sob carga. O custo dominante é a decifragem do segredo TOTP:
// a chave AES é derivada da MASTER_KEY por scrypt a cada tentativa, o mesmo fator de trabalho
// do hash de senha. Por isso o teto aqui é o do login, não o de uma rota de leitura.
//
// O cenário completo é login → desafio → verify, porque medir só o verify esconderia o custo
// de criar o desafio, que acontece uma vez por tentativa de login real.
//
// Requer um usuário de carga com fator TOTP já ativo e o segredo em base32. Sem ele o teste
// falha em voz alta em vez de medir uma rajada de 400 e parecer rápido.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SMOKE = __ENV.SMOKE === 'true';
const EMAIL = __ENV.EMAIL || 'load@iam.local';
// Sem default: senha embutida é credencial versionada, e o dia em que alguém apontar o
// script para um ambiente real ela vira a senha que ele tenta de verdade.
const SENHA = __ENV.SENHA || '';
// Segredo TOTP do usuário de carga, em base32 (o mesmo que o cadastro devolveu).
const TOTP_SECRET = __ENV.TOTP_SECRET || '';

const desafiosSemToken = new Counter('desafios_sem_token');

export const options = {
  scenarios: {
    verificacao: SMOKE
      ? { executor: 'constant-vus', vus: 5, duration: '30s' }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '1m', target: 15 },
            { duration: '2m', target: 30 },
            { duration: '1m', target: 0 },
          ],
        },
  },
  thresholds: {
    // Inclui a derivação scrypt da chave de cifra — mesmo teto do login.
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
    desafios_sem_token: ['count==0'],
  },
};

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decodifica base32 (RFC 4648) para bytes. */
function deBase32(texto) {
  const limpo = texto.toUpperCase().replace(/[\s=-]/g, '');
  const bytes = [];
  let acumulador = 0;
  let bits = 0;
  for (const caractere of limpo) {
    const valor = ALFABETO_BASE32.indexOf(caractere);
    if (valor === -1) fail(`TOTP_SECRET inválido: caractere ${caractere}`);
    acumulador = (acumulador << 5) | valor;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acumulador >>> bits) & 0xff);
    }
  }
  return bytes;
}

/** HOTP com truncamento dinâmico (RFC 4226) sobre o passo de 30 s da RFC 6238. */
function gerarCodigo(segredoBytes, passo) {
  const contador = new Uint8Array(8);
  let resto = passo;
  for (let i = 7; i >= 0; i -= 1) {
    contador[i] = resto & 0xff;
    resto = Math.floor(resto / 256);
  }
  const chave = encoding.b64encode(String.fromCharCode(...segredoBytes));
  const hmacHex = crypto.hmac(
    'sha1',
    encoding.b64decode(chave, 'std', 's'),
    contador.buffer,
    'hex',
  );
  const hmac = [];
  for (let i = 0; i < hmacHex.length; i += 2) {
    hmac.push(parseInt(hmacHex.substring(i, i + 2), 16));
  }
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binario =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binario % 1000000).padStart(6, '0');
}

export function setup() {
  if (!SENHA || !TOTP_SECRET) {
    fail('SENHA e TOTP_SECRET são obrigatórios: sem eles isto mede 400, não verificação');
  }
}

export default function () {
  const login = http.post(`${BASE}/auth/login`, JSON.stringify({ email: EMAIL, senha: SENHA }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const mfaToken = login.json('mfa_token');
  check(login, { 'login devolve desafio': () => Boolean(mfaToken) });
  if (!mfaToken) {
    // Sem desafio, o usuário de carga não tem fator ativo e o cenário mede outra coisa.
    desafiosSemToken.add(1);
    return;
  }

  const segredo = deBase32(TOTP_SECRET);
  const passo = Math.floor(Date.now() / 1000 / 30);
  const res = http.post(
    `${BASE}/auth/mfa/verify`,
    JSON.stringify({ mfa_token: mfaToken, code: gerarCodigo(segredo, passo) }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  check(res, {
    // 400 é esperado quando o passo já foi consumido por outra VU no mesmo intervalo de
    // 30 s — o anti-replay funcionando. O que não pode acontecer é erro de servidor.
    'sem erro de servidor': (r) => r.status < 500,
    'não ecoa o segredo': (r) => !r.body.includes(TOTP_SECRET),
  });
}
