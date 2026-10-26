import { PageHeader } from '../../../components/Common.jsx';
import { ApiReference } from '../../development/Shared.jsx';

export default function OpenApiDocumentationForWhm({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Every endpoint this panel mounts, generated from the live router: WHM administration, account functions and the Development API. Root-only routes configure the server; reseller routes are limited to owned accounts inside the service layer." />
      <ApiReference scope="whm" />
    </>
  );
}
