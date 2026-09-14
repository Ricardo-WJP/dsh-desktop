import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'
import './styles/native-control.css'

const root = document.getElementById('root')
if (root === null) throw new Error('找不到渲染器根节点')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
