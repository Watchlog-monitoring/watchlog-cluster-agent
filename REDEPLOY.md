# Watchlog Cluster Agent — Redeploy & Test Runbook (minikube)

A practical, step-by-step guide to (re)deploy and verify the Kubernetes cluster
agent on minikube. Keep this next to the manifest.

---

## ⭐ TL;DR — stop chasing the IP

Your Mac's LAN IP changes with DHCP, which kept breaking the agent. **Don't put
a raw IP in `WATCHLOG_SERVER`.** From inside minikube the host machine is always
reachable at:

```
http://host.minikube.internal:7896
```

This is already set in `watchlog-cluster-agent.yaml`. It survives every IP/Wi‑Fi
change — you never edit it again for local testing.

> Only use a real IP/hostname when the Watchlog server is **remote** (not your Mac).

---

## Prerequisites (one-time check)

```bash
minikube status                 # host: Running, kubelet: Running
kubectl config current-context  # should print: minikube
```

The Watchlog **server-agent** must be running on your Mac and listening on `:7896`:

```bash
lsof -nP -iTCP:7896 -sTCP:LISTEN   # should show a node process
```

No `metrics-server` is required — the agent reads metrics from the Kubelet
Summary API.

---

## Deploy / Redeploy (3 commands)

The agent runs as a Deployment named `watchlog-cluster-agent` in the **`default`**
namespace.

```bash
cd watchlog-cluster-agent

# 1) apply the manifest (creates/updates SA, RBAC, Deployment)
kubectl apply -f watchlog-cluster-agent.yaml

# 2) restart so the pod picks up any env changes (server URL, cluster name, …)
kubectl rollout restart deployment/watchlog-cluster-agent -n default

# 3) wait until it's ready
kubectl rollout status deployment/watchlog-cluster-agent -n default
```

> Step 2 matters: `apply` alone won't always recreate the pod. `rollout restart`
> guarantees the new env is used.

> The 3 commands above are enough when you only changed **config** (env in the
> YAML). If you changed the agent **code**, you must rebuild the image first —
> see the next section.

---

## Changed the agent CODE? Rebuild the image into minikube

The pod runs the container image, not your local source. After editing anything
under `app/`, rebuild the image **inside minikube** and restart:

```bash
cd watchlog-cluster-agent

# build the image directly into minikube's runtime (no registry/push needed)
minikube image build -t watchlog/watchlog-cluster-agent:latest .

# recreate the pod so it uses the freshly built image
kubectl rollout restart deployment/watchlog-cluster-agent -n default
kubectl rollout status   deployment/watchlog-cluster-agent -n default
```

Requirements for this to work (already set in the manifest):
- `imagePullPolicy: IfNotPresent` — so the kubelet uses your **local** build
  instead of pulling the old image from Docker Hub. (Use `Always` only when you
  publish a real image to a registry.)

Confirm the pod actually picked up your build (image IDs must match):

```bash
# image just built into minikube
minikube image ls --format table | grep watchlog-cluster-agent
# image the pod is running
kubectl get pod -n default -l app=watchlog-cluster-agent \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}{"\n"}'
```

---

## Verify it works (the only check that matters)

```bash
# pod should be Running
kubectl get pods -n default -l app=watchlog-cluster-agent

# confirm which server it points at
kubectl get pod -n default -l app=watchlog-cluster-agent \
  -o jsonpath='{.items[0].spec.containers[0].env[?(@.name=="WATCHLOG_SERVER")].value}{"\n"}'

# follow the logs
kubectl logs -n default -l app=watchlog-cluster-agent -f --tail=20
```

**Healthy output looks like this** (a line every ~60s):

```
Watchlog cluster agent is running.
[k8s] v2 snapshot pipeline started (interval=60000ms)
[k8s] metrics source=kubelet_summary | kubelet ok=1 fail=0 | nodes without metrics=0 | metrics-server fallback=disabled
[k8s] snapshot minikube:... (ok) nodes=1 pods=10 topoNodes=34 edges=62 80ms sent
```

- `... sent`  → reached the server ✅
- `... queued for retry: disconnected` → server **not reachable** (see troubleshooting)

---

## Test if an address is reachable from the cluster

Before trusting any `WATCHLOG_SERVER` value, test it from *inside* minikube:

```bash
minikube ssh "curl -s -m5 -o /dev/null -w '%{http_code}\n' http://host.minikube.internal:7896/"
# any HTTP code (e.g. 404) = reachable. 'UNREACHABLE'/timeout = not reachable.
```

(`404` is fine — it just means the socket server answered.)

If you ever DO need your Mac's current LAN IP:

```bash
ipconfig getifaddr en0    # Wi-Fi   (or en1 for some Macs)
```

---

## Changing settings (server URL, cluster name, API key)

Edit these env values in `watchlog-cluster-agent.yaml`, then run the 3 deploy
commands again:

```yaml
- name: WATCHLOG_SERVER
  value: "http://host.minikube.internal:7896"   # keep this for local minikube
- name: WATCHLOG_CLUSTER_NAME
  value: "minikube"
- name: WATCHLOG_APIKEY
  value: "8ed204e18781f2c99c6e0bf101ce44d8"
```

Force a fresh pod quickly without editing anything:

```bash
kubectl rollout restart deployment/watchlog-cluster-agent -n default
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Logs show `queued for retry: disconnected` | Server address unreachable from cluster | Use `host.minikube.internal:7896`; confirm server-agent is up (`lsof -iTCP:7896`) |
| UI shows the cluster **Offline** | No fresh snapshot for ~3 min (agent down / can't reach server) | Check `kubectl get pods -n default`; check logs for `sent` vs `queued` |
| UI still shows **Online** after you "changed the IP" | You didn't `rollout restart`, or the old IP is still reachable | Run `rollout restart`; verify env with the jsonpath command above |
| `kubectl top` / metrics errors | metrics-server missing | Not needed — agent uses Kubelet Summary API (`K8S_METRICS_SOURCE=kubelet_summary`) |
| Pod `CrashLoopBackOff` | Bad config / image | `kubectl describe pod -n default -l app=watchlog-cluster-agent` and read events |

### Note on a `401 ... socket connection closed (verbose: true)` error
That message comes from a server-side **fetch** (frontend/API auth), **not** from
this cluster agent — the agent talks over Socket.IO and its health is proven by
its own `... sent` log lines. If the topology + cluster list show live data,
the agent is fine; the 401 is a separate auth/session issue to chase elsewhere.

---

## Handy commands

```bash
# live logs
kubectl logs -n default -l app=watchlog-cluster-agent -f

# restart
kubectl rollout restart deployment/watchlog-cluster-agent -n default

# describe (events, why a pod won't start)
kubectl describe pod -n default -l app=watchlog-cluster-agent

# delete the agent entirely
kubectl delete -f watchlog-cluster-agent.yaml

# what's deployed
kubectl get deploy,pods -n default -l app=watchlog-cluster-agent
```
