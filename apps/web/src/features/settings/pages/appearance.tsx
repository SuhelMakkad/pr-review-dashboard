import { appearance, useAppearance, type Density, type ThemePreference } from '@/lib/theme';
import { Segmented, SettingRow, SettingsCard } from '@/features/settings/parts';

export function AppearanceSettings() {
  const { theme, density } = useAppearance();

  return (
    <SettingsCard title="Display">
      <SettingRow label="Theme" hint="System follows your macOS appearance.">
        <Segmented<ThemePreference>
          label="Theme"
          value={theme}
          onChange={appearance.setTheme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </SettingRow>
      <SettingRow label="Row density" hint="Compact shows one line per PR.">
        <Segmented<Density>
          label="Row density"
          value={density}
          onChange={appearance.setDensity}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </SettingRow>
    </SettingsCard>
  );
}
