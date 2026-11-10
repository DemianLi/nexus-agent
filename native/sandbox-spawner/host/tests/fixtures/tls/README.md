# TLS 測試夾具

**只給 `host/tests/` 的測試用，不得用於任何部署。** 私鑰隨 repo 公開，任何人都拿得到。

| 檔 | 內容 |
| --- | --- |
| `ca-a.pem` | 測試 CA a（P-256，自簽，效期 100 年） |
| `ca-b.pem` | 測試 CA b（P-256，自簽），沒有簽任何東西：設定的根換成它，就該驗不過 |
| `leaf.pem`、`leaf.key` | CA a 簽的伺服器憑證與它的私鑰（PKCS#8）。SAN 是 `localhost`、`127.0.0.1`、`mcp.nexus.test`，EKU 是 serverAuth |

`mcp.nexus.test` 是給 CONNECT 隧道的測試用的：迴圈位址一律直連、不走代理，所以目標要用一個不是迴圈位址的名字，由測試裡的代理對到 `127.0.0.1`。

CA 的私鑰產生後就刪了，不在 repo 裡。要重產，在這個資料夾跑（OpenSSL 3）：

```bash
for ca in a b; do
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca-$ca.key
  openssl req -x509 -new -key ca-$ca.key -sha256 -days 36500 -subj "/CN=nexus-test-ca-$ca" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca-$ca.pem
done
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out leaf.key
openssl req -new -key leaf.key -subj "/CN=localhost" -out leaf.csr
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,DNS:mcp.nexus.test\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA ca-a.pem -CAkey ca-a.key -CAcreateserial -sha256 -days 36500 -extfile leaf.ext -out leaf.pem
rm -f leaf.csr leaf.ext ca-a.key ca-b.key ca-a.srl
```
