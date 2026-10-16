import { AfterViewInit, Directive, ElementRef, inject, OnDestroy } from '@angular/core';

/** Native modal semantics, focus containment, Escape and focus restoration. */
@Directive({ standalone: true, selector: 'dialog[reviewDialog]' })
export class ReviewDialogDirective implements AfterViewInit, OnDestroy {
  private element = inject<ElementRef<HTMLDialogElement>>(ElementRef);
  ngAfterViewInit(): void {
    this.element.nativeElement.showModal();
  }
  ngOnDestroy(): void {
    this.element.nativeElement.close();
  }
}
