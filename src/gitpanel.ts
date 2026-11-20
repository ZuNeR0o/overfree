// Panel de Git: confirmar cambios, ver el historial y sincronizar con GitHub/GitLab.

import { desktop } from "./store";

type Status = {
  available: boolean;
  repo?: boolean;
  branch?: string;
  changes?: { status: string; path: string }[];
  remote?: string | null;
  ahead?: number;
  behind?: number;
  identity?: boolean;
};
type Commit = { hash: string; date: string; author: string; message: string };

type Deps = {
  projectId: () => string;
  flush: () => Promise<void>;
  status: (msg: string, kind?: string) => void;
  ask: (label: string, value?: string) => Promise<string | null>;
};

const STATUS_LABEL: Record<string, string> = { M: "modificado", A: "nuevo", D: "eliminado", R: "renombrado", "??": "nuevo", U: "conflicto" };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

export function createGitPanel(root: HTMLElement, deps: Deps) {
  let busy = false;

  const run = async <T>(action: string, body?: Record<string, string>) => {
    if (!desktop) throw new Error("Solo disponible en la app de escritorio.");
    return desktop.git<T>(deps.projectId(), action, body);
  };

  async function guard(label: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    deps.status(label);
    try {
      await fn();
    } catch (e) {
      deps.status(e instanceof Error ? e.message.split("\n")[0] : String(e), "error");
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
      void refresh();
    }
  }

  async function refresh() {
    if (!desktop) return;
    const pid = deps.projectId();
    root.replaceChildren(h("p", { cls: "muted pad" }, "Cargando…")); // evita operar con datos de otro proyecto
    let st: Status;
    try {
      st = await run<Status>("status");
      if (pid !== deps.projectId()) return; // cambió de proyecto mientras tanto
    } catch (e) {
      root.replaceChildren(h("p", { cls: "muted pad" }, e instanceof Error ? e.message : String(e)));
      return;
    }
    if (!st.available) {
      root.replaceChildren(
        h("p", { cls: "pad" }, "Git no está instalado en este equipo."),
        h("p", { cls: "muted pad" }, "Instálalo desde git-scm.com y vuelve a abrir Folio."),
      );
      return;
    }
    if (!st.repo) {
      const b = h("button", { type: "button", cls: "btn primary small" }, "Activar control de versiones");
      b.onclick = () =>
        guard("Creando repositorio…", async () => {
          await deps.flush();
          await run("init");
          await run("commit", { message: "Versión inicial" }).catch(() => undefined);
          deps.status("Control de versiones activado.");
        });
      root.replaceChildren(
        h("div", { cls: "pad" }, h("p", {}, "Guarda versiones con nombre de tu proyecto y sincronízalas con GitHub o GitLab."), b),
      );
      return;
    }

    const changes = st.changes ?? [];
    const msg = h("textarea", { cls: "git-msg", placeholder: "Describe los cambios (p. ej. «Capítulo 3 terminado»)", rows: 2 });
    const commitBtn = h("button", { type: "button", cls: "btn primary small", disabled: !changes.length }, `Confirmar ${changes.length || ""} cambio${changes.length === 1 ? "" : "s"}`);
    commitBtn.onclick = () =>
      guard("Confirmando cambios…", async () => {
        await deps.flush();
        const body: Record<string, string> = { message: msg.value };
        if (!st.identity) {
          const name = await deps.ask("Tu nombre para el historial de Git:");
          const email = name ? await deps.ask("Tu correo para el historial de Git:") : null;
          if (!name || !email) return deps.status("Confirmación cancelada.");
          Object.assign(body, { name, email });
        }
        await run("commit", body);
        deps.status("Cambios confirmados.");
      });

    const remoteLabel = st.remote ? st.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "") : "sin repositorio remoto";
    const syncBtn = h("button", { type: "button", cls: "btn ghost-inline small", disabled: !st.remote }, "Sincronizar");
    syncBtn.title = "Trae los cambios del remoto y sube los tuyos";
    syncBtn.onclick = () =>
      guard("Sincronizando…", async () => {
        await deps.flush();
        await run("sync");
        deps.status("Sincronizado con el repositorio remoto.");
      });
    const remoteBtn = h("button", { type: "button", cls: "btn ghost-inline small" }, st.remote ? "Cambiar remoto" : "Conectar con GitHub…");
    remoteBtn.onclick = async () => {
      const url = await deps.ask("URL del repositorio remoto (p. ej. https://github.com/usuario/tesis.git). Déjalo vacío para quitarlo:", st.remote ?? "");
      if (url === null) return;
      void guard("Guardando remoto…", async () => {
        await run("remote", { url });
        deps.status(url ? "Repositorio remoto conectado." : "Repositorio remoto quitado.");
      });
    };

    const list = h(
      "ul",
      { cls: "git-changes" },
      ...(changes.length
        ? changes.map((c) =>
            h("li", {}, h("span", { cls: `git-st st-${c.status.replace("??", "N")[0]}` }, STATUS_LABEL[c.status] ?? STATUS_LABEL[c.status[0]] ?? c.status), h("span", { cls: "git-path" }, c.path)),
          )
        : [h("li", { cls: "muted" }, "Sin cambios pendientes.")]),
    );

    const logBox = h("ul", { cls: "git-log" }, h("li", { cls: "muted" }, "Cargando historial…"));
    root.replaceChildren(
      h("div", { cls: "git-head" }, h("strong", {}, `Rama ${st.branch}`), h("span", { cls: "muted" }, st.ahead || st.behind ? ` · ↑${st.ahead} ↓${st.behind}` : "")),
      list,
      msg,
      h("div", { cls: "git-row" }, commitBtn),
      h("div", { cls: "git-sub" }, h("span", { cls: "muted" }, remoteLabel)),
      h("div", { cls: "git-row" }, syncBtn, remoteBtn),
      h("div", { cls: "git-sub" }, h("strong", {}, "Historial")),
      logBox,
    );
    const commits = await run<Commit[]>("log").catch(() => []);
    logBox.replaceChildren(
      ...(commits.length
        ? commits.map((c) =>
            h(
              "li",
              { title: `${c.hash} · ${c.author}` },
              h("span", { cls: "git-log-msg" }, c.message),
              h("span", { cls: "muted" }, new Date(c.date).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })),
            ),
          )
        : [h("li", { cls: "muted" }, "Todavía no hay versiones confirmadas.")]),
    );
  }

  return { refresh };
}
