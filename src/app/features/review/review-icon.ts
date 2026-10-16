import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

const paths = {
  box: 'm12 3 9 5v8l-9 5-9-5V8l9-5Zm0 9 9-4M12 12 3 8m9 4v9M7.5 5.5l9 5',
  image:
    'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm-1 14 6-6 4 4 3-3 5 5M16 7h.01',
  layers: 'm12 3 10 6-10 6L2 9l10-6ZM2 13l10 6 10-6M2 17l10 6 10-6',
  tag: 'M3 3h8l10 10-8 8L3 11V3Zm5 5h.01',
  truck: 'M1 4h13v12H1V4Zm13 4h5l4 5v3h-9M5 16a2 2 0 1 0 .01 0M18 16a2 2 0 1 0 .01 0',
  check: 'm5 12 4 4L19 6',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  close: 'm6 6 12 12M6 18 18 6',
  left: 'm15 6-6 6 6 6',
  right: 'm9 6 6 6-6 6',
  zoom: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm4.5 10.5L21 21M7 10h6m-3-3v6',
  save: 'M4 3h13l4 4v14H3V3h1Zm3 0v6h10V3M7 21v-8h10v8',
} as const;

/** Small local SVG set: no font loading or additional icon dependency. */
@Component({
  selector: 'review-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="paths[name]" /></svg>',
  styles:
    ':host{display:inline-flex;width:20px;height:20px;flex-shrink:0}svg{width:100%;height:100%}',
})
export class ReviewIcon {
  @Input({ required: true }) name!: keyof typeof paths;
  readonly paths = paths;
}
