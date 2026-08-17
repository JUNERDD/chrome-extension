import type { SVGProps } from 'react';

export type IconName =
  | 'archive'
  | 'arrow-up-right'
  | 'camera'
  | 'check'
  | 'clipboard'
  | 'download'
  | 'erase'
  | 'gear'
  | 'pause'
  | 'play'
  | 'record'
  | 'refresh'
  | 'shield'
  | 'stop'
  | 'warning';

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const paths: Record<IconName, React.ReactNode> = {
    archive: (
      <>
        <path d="M4 7h16v13H4z" />
        <path d="M3 3h18v4H3zM9 11h6" />
      </>
    ),
    'arrow-up-right': <path d="M7 17 17 7M8 7h9v9" />,
    camera: (
      <>
        <path d="M4 7h3l1.6-2h6.8L17 7h3v12H4z" />
        <circle cx="12" cy="13" r="3.2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    clipboard: (
      <>
        <path d="M9 5H6v16h12V5h-3" />
        <path d="M9 3h6v4H9z" />
      </>
    ),
    download: <path d="M12 3v12m-5-5 5 5 5-5M5 21h14" />,
    erase: (
      <>
        <path d="M5 7h14M9 7V4h6v3m2 0-1 14H8L7 7" />
        <path d="M10 11v6m4-6v6" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.5 6A8 8 0 0 0 9 7L6.6 6.1l-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4L9 17a8 8 0 0 0 1.5 1l.3 2.6h4L15 18a8 8 0 0 0 1.5-1l2.4.9 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
      </>
    ),
    pause: <path d="M8 5v14m8-14v14" />,
    play: <path d="m8 5 11 7-11 7Z" />,
    record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5m9.7-3A8 8 0 0 0 5.5 7M5.3 15A8 8 0 0 0 18.5 17" />,
    shield: <path d="M12 3 5 6v5c0 4.8 2.8 8 7 10 4.2-2 7-5.2 7-10V6l-7-3Zm-3 9 2 2 4-5" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
    warning: <path d="M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3v.1" />,
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      {paths[name]}
    </svg>
  );
}
