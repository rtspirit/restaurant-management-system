// @rms/ui: tokens, components and patterns. The only UI library RMS and every mini-app may use.
//
// Load the stylesheet once per app: `import "@rms/ui/styles.css"`.
// Components take no className and no style. Layout comes from Stack, Row, Columns and
// the patterns, so screens can be composed without writing any CSS.

// Brand colour safety
export { themeFromBrand, contrastRatio, relativeLuminance, chromaOf, darkenToContrast, normaliseHex, DEFAULT_BRAND, SURFACES, AA_TEXT, MIN_CHROMA, MIN_INK_CONTRAST } from "./theme";
export type { BrandTheme } from "./theme";
export { Theme } from "./theme-provider";
export type { ThemeProps } from "./theme-provider";

// Icons
export { Icon, ICON_NAMES } from "./icons";
export type { IconName, IconProps } from "./icons";

// Components
export { Button, IconButton } from "./components/button";
export type { ButtonProps, IconButtonProps } from "./components/button";
export { TextField, Select, FieldPair } from "./components/fields";
export { Choice, ChoiceList, TextArea, FieldGroup, Notice } from "./components/choices";
export type { ChoiceProps, ChoiceListProps, TextAreaProps, FieldGroupProps, NoticeProps } from "./components/choices";
export type { TextFieldProps, SelectProps, SelectOption, FieldPairProps } from "./components/fields";
export { Tabs } from "./components/tabs";
export type { TabsProps, TabItem } from "./components/tabs";
export { Card, Tag } from "./components/card";
export type { CardProps, TagProps } from "./components/card";
export { Stat, StatLead, StatGroup } from "./components/stat";
export type { StatProps, StatLeadProps, StatGroupProps } from "./components/stat";
export { DataTable } from "./components/data-table";
export type { DataTableProps, DataTableColumn, DataTableRow, DataTableSort } from "./components/data-table";
export { BarChart } from "./components/bar-chart";
export type { BarChartProps, BarChartItem } from "./components/bar-chart";
export { Stepper } from "./components/stepper";
export type { StepperProps, StepperStep, StepState } from "./components/stepper";
export { Conversation, Message, Answers } from "./components/conversation";
export type { ConversationProps, MessageProps, AnswersProps, Answer } from "./components/conversation";
export { Composer } from "./components/composer";
export type { ComposerProps } from "./components/composer";
export { Dialog } from "./components/dialog";
export type { DialogProps } from "./components/dialog";
export { Frame, FRAME_SANDBOX, FRAME_REFERRER_POLICY, FRAME_ALLOW, type FrameProps } from "./components/frame";
export { Logo, TabLinks, NavItem, NavList, BottomBar, BottomBarItem, Avatar, Account, Pager } from "./components/nav";
export type {
  LogoProps,
  TabLinksProps,
  TabLink,
  NavItemProps,
  NavListProps,
  BottomBarProps,
  BottomBarItemProps,
  AvatarProps,
  AccountProps,
  PagerProps,
} from "./components/nav";
export { Skeleton, EmptyState } from "./components/feedback";
export type { SkeletonProps, EmptyStateProps } from "./components/feedback";
export { Heading, Text, BulletList, Stack, Row, Columns, Density } from "./components/text";
export type { HeadingProps, TextProps, BulletListProps, StackProps, RowProps, ColumnsProps, DensityProps } from "./components/text";
export { AppShell, Rail, TopBar, Page, Section, Dock, Canvas, CanvasHeader, Narrow } from "./components/shell";
export type { AppShellProps, RailProps, TopBarProps, PageProps, SectionProps, DockProps, CanvasProps, CanvasHeaderProps, NarrowProps } from "./components/shell";

// Patterns
export { Dashboard } from "./patterns/dashboard";
export type { DashboardProps } from "./patterns/dashboard";
export { ListDetail, DetailList } from "./patterns/list-detail";
export type { ListDetailProps, ListDetailItem, DetailListProps } from "./patterns/list-detail";
export { FormLayout } from "./patterns/form";
export type { FormLayoutProps } from "./patterns/form";
export { QuestionForm } from "./patterns/question";
export type { QuestionFormProps } from "./patterns/question";
export { ReportTable } from "./patterns/report-table";
export type { ReportTableProps } from "./patterns/report-table";
export { Workbench, Feed } from "./patterns/workbench";
export type { WorkbenchProps, FeedProps, FeedItem } from "./patterns/workbench";
