import { ConfigPage } from '../../components/ConfigPage.jsx';

export default function BasicSetup({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="basic." groups={[
      { title: 'Contact information', fields: [
        { key: 'basic.contact_email', label: 'Server contact email address', type: 'text', inputType: 'email', help: 'Receives alerts, reports and license notices.' },
      ] },
      { title: 'Basic configuration', fields: [
        { key: 'basic.hostname', label: 'Hostname', help: 'Fully qualified; changing it here does not change the system hostname — use Networking Setup › Change Hostname.' },
        { key: 'basic.main_ip', label: 'Main server IP address', help: 'Primary IPv4 address of this server.' },
        { key: 'basic.shared_ip', label: 'Shared virtual host IP address', help: 'New accounts without a dedicated IP use this address.' },
        { key: 'basic.home_root', label: 'Home directory root', help: 'New account home directories are created under this path.' },
        { key: 'basic.default_package', label: 'Default package', help: 'Used when an account is created without an explicit package.' },
      ] },
      { title: 'Nameservers', description: 'Nameservers written into every new DNS zone.', fields: [
        { key: 'basic.nameservers', label: 'Nameservers', type: 'list', placeholder: 'ns1.example.com, ns2.example.com' },
      ] },
    ]} />
  );
}
