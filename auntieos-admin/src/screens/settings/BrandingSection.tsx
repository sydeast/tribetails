import { type BusinessSettings } from '../../api/settings';
import { type ConfirmBrandAssetResult } from '../../api/brandAsset';
import { type ImageDecoder } from '../../lib/brandAssetFile';
import { DenPanel } from '../../components/DenScreenKit';
import { TextFieldsSection, BRANDING_FIELDS } from './sections';
import { LogoUploadField } from './LogoUploadField';

interface BrandingSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
  /**
   * Folds an ALREADY-PERSISTED server result into the loaded settings, without
   * writing again. The logo is saved by `confirmBrandAssetUpload`, so routing
   * it back through the screen's `persist` would issue a second, pointless
   * write of a value the server just wrote, and re-stamp `updatedBy` from the
   * client over the stamp the callable made.
   */
  onServerChanged: (patch: Partial<BusinessSettings>) => void;
  decode?: ImageDecoder;
}

/**
 * Branding: the operator's own logo, plus the wordmark/tagline/greeting text.
 *
 * Two panels rather than one, because they save differently and saying so is
 * clearer than hiding it. The logo commits the moment its upload succeeds (the
 * bytes are already in Cloudinary; a Save button would be theatre). The text
 * fields stage into the existing shared Save bar exactly as before.
 */
export function BrandingSection({ data, onSave, onServerChanged, decode }: BrandingSectionProps) {
  function applyLogo(result: ConfirmBrandAssetResult) {
    onServerChanged({ logoUrl: result.logoUrl, logoRemovedAt: result.logoRemovedAt });
  }

  return (
    <>
      <DenPanel
        title="Logo"
        subtitle="Your brand mark inside this admin. Saves as soon as the upload finishes."
      >
        <LogoUploadField
          kind="businessLogo"
          label="Business logo"
          help="Shown in this admin. It is NOT what kinfolk see: the portal has its own logo, under MyTribe portal."
          logoUrl={data.logoUrl}
          logoRemovedAt={data.logoRemovedAt}
          onChanged={applyLogo}
          preview="admin"
          {...(decode ? { decode } : {})}
        />
      </DenPanel>

      <TextFieldsSection
        title="Branding"
        subtitle="App name, tagline, and Home greeting. Leave any field blank to keep the shipped default."
        data={data}
        fields={BRANDING_FIELDS}
        onSave={onSave}
      />
    </>
  );
}
