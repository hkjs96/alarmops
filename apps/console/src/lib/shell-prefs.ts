/** Tree column state of the scope shell. Plain module: the root layout (server) and ScopeShell (client) both read it. */

/** Below this width, opening a panel collapses the tree to its rail (the user can open it again beside the panel). */
export const AUTO_RAIL_BELOW = 1408;
/** Without a remembered choice the tree starts as a rail up to this width. */
export const DEFAULT_RAIL_MAX = 1100;
/** sessionStorage: { col: collapsed by the user (boolean | null), w: tree width } — no names, no ids */
export const PREFS_KEY = "ao-scope-shell";

/**
 * Runs in <head>, before the first paint (QA P2-2). The remembered rail state and tree width live in sessionStorage and
 * the automatic rail depends on the window width, so the server cannot render them. This marks <html> with what the
 * shell is about to decide, and globals.css sizes the tree column from it until the shell has mounted (.shell.mounted).
 * Must stay in step with the `rail` expression in ScopeShell.
 */
export const shellInitScript = `try{var d=document.documentElement,w=window.innerWidth,s=null;try{s=JSON.parse(sessionStorage.getItem("${PREFS_KEY}"))}catch(e){}var c=s&&typeof s.col==="boolean"?s.col:null;if((location.pathname.indexOf("/c/")===0&&w<${AUTO_RAIL_BELOW})||(c===null?w<=${DEFAULT_RAIL_MAX}:c))d.setAttribute("data-pre-rail","1");var t=s&&Number(s.w);if(t)d.style.setProperty("--pre-stree-w",Math.max(200,Math.min(360,Math.round(t)))+"px")}catch(e){}`;
