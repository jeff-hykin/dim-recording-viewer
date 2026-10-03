import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { followTheme } from "./theme.ts"
import "./theme.css"
import "./app.css"

followTheme()
createRoot(document.getElementById("root")!).render(<App />)
