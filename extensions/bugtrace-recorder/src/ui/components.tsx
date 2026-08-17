import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { Icon, type IconName } from './icons';

type Tone = 'neutral' | 'recording' | 'paused' | 'success' | 'warning';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Bugtrace Recorder">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="brand-name">BUGTRACE</span>
      {!compact && <span className="brand-model">REC / 01</span>}
    </div>
  );
}

export function StatusBeacon({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return (
    <span className={`status-beacon status-beacon--${tone}`}>
      <span className="status-beacon__light" aria-hidden="true" />
      {label}
    </span>
  );
}

export function SectionHeading({
  children,
  index,
  aside,
}: PropsWithChildren<{ index?: string; aside?: ReactNode }>) {
  return (
    <div className="section-heading">
      <div>
        {index && <span className="section-heading__index">{index}</span>}
        <h2>{children}</h2>
      </div>
      {aside && <div className="section-heading__aside">{aside}</div>}
    </div>
  );
}

interface InstrumentButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  intent?: 'primary' | 'danger' | 'quiet' | 'amber';
  keyHint?: string;
}

export function InstrumentButton({
  children,
  icon,
  intent = 'quiet',
  keyHint,
  className = '',
  ...props
}: InstrumentButtonProps) {
  return (
    <button className={`instrument-button instrument-button--${intent} ${className}`} {...props}>
      {icon && <Icon name={icon} size={17} />}
      <span>{children}</span>
      {keyHint && <kbd>{keyHint}</kbd>}
    </button>
  );
}

export function Notice({
  children,
  tone = 'warning',
  title,
}: PropsWithChildren<{ tone?: 'warning' | 'danger' | 'info' | 'success'; title?: string }>) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={tone === 'success' ? 'check' : tone === 'info' ? 'shield' : 'warning'} size={16} />
      <div>
        {title && <strong>{title}</strong>}
        <span>{children}</span>
      </div>
    </div>
  );
}

export function Reading({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="reading">
      <span className="reading__label">{label}</span>
      <span className="reading__value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

export function LoadingPlate({ label = 'Reading local evidence…' }: { label?: string }) {
  return (
    <div className="loading-plate" role="status">
      <span className="loading-plate__dial" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyPlate({
  title,
  children,
}: PropsWithChildren<{ title: string }>) {
  return (
    <div className="empty-plate">
      <span className="empty-plate__cross" aria-hidden="true">×</span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
