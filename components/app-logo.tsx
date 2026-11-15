import Image from "next/image";

export function AppLogo({ size = 36 }: { size?: number }) {
  return <Image src="/chrona-logo.png" alt="" width={1369} height={1149} sizes={`${size}px`} style={{ width: size, height: "auto" }} className="shrink-0 object-contain" />;
}
