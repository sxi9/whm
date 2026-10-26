import RebootPage from '../../reboot/RebootPage.jsx';

export default function GracefulServerReboot({ fn }) {
  return <RebootPage fn={fn} mode="graceful" />;
}
