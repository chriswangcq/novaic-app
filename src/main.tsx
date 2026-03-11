import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';

// iOS/移动端：键盘弹出时缩小视口高度，避免整页上推
const vv = typeof window !== 'undefined' ? window.visualViewport : null;
if (vv) {
  const setViewportHeight = () => {
    const h = vv.height;
    document.documentElement.style.setProperty('--visual-viewport-height', `${h}px`);
    document.documentElement.style.height = `${h}px`;
  };
  vv.addEventListener('resize', setViewportHeight);
  vv.addEventListener('scroll', setViewportHeight);
  setViewportHeight();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
