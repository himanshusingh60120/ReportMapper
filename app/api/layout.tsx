import './globals.css';

export const metadata = {
  title: 'Prospect → Report Matcher',
  description: 'Match prospects to Kings Research reports',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
