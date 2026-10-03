// Follow dimOS Desktop's light/dark choice: the shell writes localStorage "dimos.themeChoice" ("light" | "dark", missing = dark),
// apps are same-origin iframes, so read it once and again on every `storage` event. Load as the first thing in <body>.
;(function () {
    const KEY = "dimos.themeChoice"
    function apply() {
        let light = false
        try {
            light = localStorage.getItem(KEY) === "light"
        } catch {}
        document.documentElement.style.colorScheme = light ? "light" : "dark"
        if (document.body) {
            document.body.classList.add("science")
            document.body.classList.toggle("dark", !light)
        }
        window.dispatchEvent(new CustomEvent("dim-theme", { detail: { dark: !light } }))
    }
    if (document.body) {
        apply()
    } else {
        document.addEventListener("DOMContentLoaded", apply)
    }
    window.addEventListener("storage", (event) => {
        if (event.key === KEY || event.key === null) {
            apply()
        }
    })
})()
