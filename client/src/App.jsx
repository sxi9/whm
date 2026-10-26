import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { ConfirmProvider } from './components/Modal.jsx';
import { ThemeLoader } from './theme/ThemeLoader.jsx';
import { router } from './router.jsx';

export default function App() {
  return (
    <AuthProvider>
      <ThemeLoader />
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
