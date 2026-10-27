import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import BasicSetup from '../../server-configuration/BasicSetup.jsx';
import LicenseTab from '../../server-configuration/LicenseTab.jsx';
import { Tabs } from '../../security/Shared.jsx';

export const TABS = [{ value: 'settings', label: 'Settings' }, { value: 'license', label: 'License' }];

// Basic WebHost Manager Setup carries the License tab: the only place a license
// key is entered. #license (the degraded-mode action link) opens it directly.
export default function BasicWebhostManagerSetup({ fn }) {
  const location = useLocation();
  const [tab, setTab] = useState(location.hash === '#license' ? 'license' : 'settings');
  useEffect(() => { if (location.hash === '#license') setTab('license'); }, [location.hash]);
  return (
    <>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'license' ? <LicenseTab fn={fn} /> : <BasicSetup fn={fn} />}
    </>
  );
}
