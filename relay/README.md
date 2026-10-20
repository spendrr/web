# Push relay: nasazení

Návrh: [docs/payment-push-relay.md](../docs/payment-push-relay.md).

## 1. Instalace (jednou)

Na Macu z kořene repa:

```bash
scp -i ~/.ssh/relay_key scripts/push-relay/bootstrap.sh scripts/push-relay/spendrr-relay.service ubuntu@<IP>:
ssh -i ~/.ssh/relay_key ubuntu@<IP> sudo bash bootstrap.sh
```

Skript: aktualizace a automatické bezpečnostní aktualizace, SSH jen klíčem, Node 24 LTS (ověřený
kontrolní součet), `cloudflared`, uživatel `relay`, náhodné secrety v `/etc/spendrr-relay/env` a služba
`spendrr-relay` (systemd, zamčená na vlastní databázi). Dá se pustit znovu.

## 2. Kód

```bash
scripts/push-relay/deploy.sh <IP>
```

Zkopíruje `relay/*.ts` a `worker/mailboxProto.ts`, restartuje službu a vypíše `/health`. Jen z
commitnutého stavu.

## 3. Cloudflare Tunnel a Access

1. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared, název `spendrr-push-relay`.
2. Token z instalačního příkazu vlož na serveru:
   `sudo cloudflared service install <TOKEN>`
3. V tunelu Public hostname: `push-relay.spendrr.app`, služba `HTTP` → `localhost:8788`.
4. Zero Trust → Access → Applications → Add → Self-hosted, doména `push-relay.spendrr.app`, policy
   **Service Auth** se stejným service tokenem, jaký používá `ln-node.example.com` (Worker ho už má
   jako `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`).

Žádný port na serveru se neotevírá, tunel jde jen ven.

## 4. Secrety ve workeru

Hodnoty jdou ze serveru rourou rovnou do wrangleru, nikde se nevypíšou (potřebuje přihlášení do Cloudflare):

```bash
ssh -i ~/.ssh/relay_key ubuntu@<IP> "sudo grep ^RELAY_TOKEN= /etc/spendrr-relay/env | cut -d= -f2" | npx wrangler secret put PUSH_RELAY_TOKEN
ssh -i ~/.ssh/relay_key ubuntu@<IP> "sudo grep ^HOOK_SECRET= /etc/spendrr-relay/env | cut -d= -f2" | npx wrangler secret put PUSH_RELAY_HOOK_SECRET
```

`PUSH_RELAY_URL` je ve `wrangler.toml`. Dokud chybí některý secret, worker relay nepoužívá.

## 5. Co sledovat

- `journalctl -u spendrr-relay -f`: jednou za minutu počty streamů a ťuknutí.
- Prvních 25 hodin je relay „studený“: ťuká hned, ale shardy dál čtou mailboxy každou minutu. Potom
  přejdou na 15 minut.
- `ended` počty konců streamů podle gRPC statusu (`reset` = bez statusu). Stálý velký počet `reset`
  nebo `0` znamená, že server streamy zavírá (třeba idle timeout), a stojí za dotaz u Second.
- `deferred` / `waiting`: ťuknutí odložená rozpočtem. Trvale nenulové `waiting` = rozpočet je malý.
- `refused` roste: Ark server odmítá autorizace (prošlé, cizí). `open` výrazně pod `live`: Ark server
  streamy neunese nebo omezuje, `/health` pak hlásí `ok: false` a shardy se vrátí na minutový interval.
