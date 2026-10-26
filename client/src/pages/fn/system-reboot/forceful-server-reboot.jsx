import RebootPage from '../../reboot/RebootPage.jsx';

export default function ForcefulServerReboot({ fn }) {
  return <RebootPage fn={fn} mode="forceful" />;
}
